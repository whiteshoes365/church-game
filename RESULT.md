# RESULT

## Question bank as JSON data + category mixing (2026-11-04)

Moved the OX quiz question bank out of `server/src/questions.js` and into versioned JSON
data files under `server/data/questions/<YYYY-WW>.json` (ISO week), loaded at server
startup — no DB. Added two new content categories (general knowledge, nonsense/pun) on
top of the existing bible questions, wired end-to-end so each game mixes categories
~70/20/10, and added a validation script for adding new weekly question files.
`toss-app/` was not touched. `VERIFY_WS_URL` support is preserved.

## Data (`server/data/questions/2026-45.json`)

- Migrated the original 120 bible questions from `server/src/questions.js` into this
  file (`category: 'bible'`), adding a `ref` field to every one (parsed from the
  existing explanation text, or filled in by hand where the explanation didn't lead
  with a citation) and a `week: '2026-45'` field.
- Fixed the elementary manger question per request: text is now `'아기 예수님은
  베들레헴에서 태어나 구유에 누이셨어요.'` (answer `O`, ref `누가복음 2:7`).
- Added a starter set of **general** (상식) and **nonsense** (넌센스) questions for the
  same week, ~9 general + 5 nonsense per level (36 + 20 = 56 new questions), kid-safe,
  accurate, and non-controversial. Nonsense questions follow a "the answer to this pun
  riddle is ___" O/X format with the real wordplay explained in `explanation`.
- Every id and `text` is unique across the whole 176-question bank (checked at load
  time and by `scripts/add-week.mjs`).

**Totals per level × category (O/X split):**

| Level | 성경(bible) | 상식(general) | 넌센스(nonsense) | Level total |
|---|---|---|---|---|
| elementary (초등) | 30 (O15/X15) | 9 (O5/X4) | 5 (O3/X2) | 44 |
| middle (중등) | 30 (O15/X15) | 9 (O5/X4) | 5 (O3/X2) | 44 |
| high (고등) | 30 (O15/X15) | 9 (O5/X4) | 5 (O3/X2) | 44 |
| youth (청년) | 30 (O15/X15) | 9 (O5/X4) | 5 (O3/X2) | 44 |
| **Total** | **120** | **36** | **20** | **176** |

**2 sample nonsense questions (with answers):**

- "세상에서 가장 뜨거운 과일은 '천도복숭아'예요." → **O** — 복숭아 이름 '천도'가 숫자
  1000(천)과 온도를 나타내는 '도'처럼 들려서 생긴 말장난이에요.
- "세상에서 가장 빠른 개는 '진돗개'예요." → **X** — 정답은 '번개'예요. 번개의 '개' 글자
  때문에 생긴 말장난이거든요.

## `server/src/questions.js` (now a loader, not data)

Reads every `*.json` file under `server/data/questions/`, errors on any duplicate `id`
across files, and exposes the same surface other modules already depended on —
`LEVELS`, `LEVEL_LABELS`, `DEFAULT_LEVEL`, `QUESTIONS_BY_LEVEL`, `QUESTIONS`,
`normalizeLevel`, `questionsForLevel` — plus new exports: `CATEGORIES`,
`CATEGORY_LABELS`, `DEFAULT_QUESTION_COUNT` (30), `CATEGORY_RATIOS` (0.7/0.2/0.1),
`ALL_QUESTIONS`, `QUESTIONS_BY_LEVEL_CATEGORY`, `categoryCounts(total)`, and
`selectQuizQuestions({ level, count, excludeIds })`.

`selectQuizQuestions` fills each category's desired share first, falls back to other
categories (then the full level pool) if a category runs short, prefers ids not in
`excludeIds`, and shuffles the result.

## Server (`state.js` / `index.js`)

- `createRoom` accepts optional `questionCount` (stored as `room.questionCount`,
  defaulting to 30); `startQuiz(room, questionCount)` uses the explicit value if given,
  else the room's default, and calls `selectQuizQuestions` for `room.level`.
- Per-church in-memory history (`recentGamesByChurch`, last 5 games) is excluded first
  when selecting a new game's questions, so a church sees fresh questions across
  consecutive games wherever the bank is large enough to allow it; resets on restart
  (no DB), as specified.
- `room.questions` now holds the full selected question objects (replacing the old
  index-based `room.questionOrder`); `currentQuestion`, `advanceQuestion`,
  `revealAnswer`, and `serializeRoom` were updated accordingly. The question snapshot
  and `lastResult` both now include `category`.

## Client

- `protocol.ts`: new `Category` type; `QuestionSnapshot`/`LastResult` gain `category`.
- New `client/src/categories.ts`: `CATEGORY_LABELS`/`CATEGORY_CLASS` (성경/상식/넌센스).
- `HostRoom.tsx` / `PlayerRoom.tsx`: small category badge shown next to the question
  (host strip, player question card) and on the reveal banner.
- `HostRooms.tsx`: room-create screen gets a 10/20/30 question-count picker, sent as
  `questionCount` in `createRoom`.
- `index.css`: `--category-*` colors and `.badge-category`/`.category-*` classes,
  matching the existing level-badge styling.

## `scripts/add-week.mjs` (+ `npm run add-week`, `docs/example-week.json`)

Validates a weekly question JSON file — per-field schema, `level`/`category`
membership, `O`/`X` answer, `ref` required for `bible`, `week` format and consistency,
duplicate `id`/`text` within the file and against the whole existing bank — then
writes (merging if the week file already exists) into
`server/data/questions/<week>.json`. Recommended per-level counts (30: ~21 bible, 6
general, 3 nonsense) and O/X balance are warnings only. Any validation error exits
non-zero and writes nothing. `--dry-run` runs all validation/warnings but never writes.
`docs/example-week.json` is a small valid example (week `2026-46`, all 4 levels, all 3
categories) used by both the docs and `verify.mjs`.

## `docs/WEEKLY.md`

Korean doc explaining the weekly format (30/level/week, ~21/6/3 split), every field's
meaning, how to run `npm run add-week -- <file>` (and `--dry-run`), and the git
add/commit/push flow to deploy.

## Verify (`verify/verify.mjs`)

Kept `VERIFY_WS_URL`, buffered `waitFor`, and all pre-existing scenarios unchanged
(church/room, movement/zones, difficulty levels). Added a new section:

- **Categories present + mixing ratio + level sourcing + no repeats**: plays a full
  default (30-question) game end-to-end and asserts every question has a valid
  `category`, the exact 21/6/3 bible/general/nonsense split, every question belongs to
  the room's level, and no question text repeats within the game.
- **Recent-avoidance across two games, same church**: plays two consecutive
  10-question games in the same room/church and asserts zero overlap in the bible
  questions used (bank has 30 bible questions for 7+7=14 needed, so the bank "allows"
  full avoidance).
- **add-week validation**: spawns `scripts/add-week.mjs --dry-run` on a deliberately
  broken file (invalid level, missing bible `ref`) and asserts a non-zero exit; spawns
  it on `docs/example-week.json --dry-run` and asserts exit 0 and that no
  `server/data/questions/2026-46.json` file gets written.

## Verification performed

- `npm run build` — passes (`tsc` clean, `vite build` succeeds).
- `npm run verify` — passes, run **3 times** consecutively, no flakes, including all
  new category/recent-avoidance/add-week checks.
- Manually ran `scripts/add-week.mjs` against `docs/example-week.json` (both normal and
  `--dry-run`) and against a hand-crafted broken file, confirming correct accept/reject
  behavior and that re-running on already-merged content is rejected as duplicate
  id/text (not silently re-merged).

## Deploy note

`server/data/questions/*.json` are plain files tracked by git (nothing in `.gitignore`
excludes them), so a normal Render build/deploy picks them up automatically — no DB
migration or extra build step needed. No commit was made as part of this change; the
working tree is left for review before committing/pushing.
