# RESULT

## Remove 'general' category; 90/10 bible/nonsense mixing; drop joke framing (2026-11-05)

The question bank was re-curated by the owner down to 86 bible-only questions
(elementary 18, middle 25, high 22, youth 21; 0 general, 0 nonsense). This change
removes the `general`(상식) category from the whole stack, switches mixing to
~90% bible / 10% nonsense, and hardens `verify.mjs` for the smaller bank and a
flaky score assertion. `toss-app/` and `server/data/questions/*.json` content were
not touched.

## Server (`server/src/questions.js`)

- `CATEGORIES` is now `['bible', 'nonsense']`; `CATEGORY_LABELS` drops `general`.
- `CATEGORY_RATIOS` is now `{ bible: 0.9, nonsense: 0.1 }` (was 0.7/0.2/0.1).
- `loadAllQuestions()` now throws if any question's `category` isn't in
  `CATEGORIES` — a stray `general` question in a data file fails server startup
  instead of silently loading.
- `selectQuizQuestions` logic (fallback to the other category, then the full
  level pool, when one runs short; capped to pool size with no error when the
  bank is smaller than the requested count; no repeats) was already written
  generically against `CATEGORIES` and needed no changes.

## Client

- `protocol.ts`: `Category` type is now `'bible' | 'nonsense'`.
- `categories.ts`: `CATEGORY_LABELS`/`CATEGORY_CLASS` drop the `general` entry.
- `index.css`: removed `--category-general` and `.category-general` rule. The
  `general` category tag was never a distinct "joke" label — `넌센스` already
  reads as a plain category name, so no UI copy changes were needed there.
- No other client code references categories by name (badges key off the maps
  above generically), so nothing else to change.

## `scripts/add-week.mjs` / `docs/WEEKLY.md` / `docs/example-week.json`

- `add-week.mjs`: recommended-count warning logic now checks bible(90%)/
  nonsense(10%) instead of bible/general/nonsense. `category` validation
  already rejects anything outside `CATEGORIES` (imported from
  `questions.js`), so a `general` question now fails with `category 값이
  올바르지 않아요: "general" (허용: bible, nonsense)` and a non-zero exit —
  verified explicitly in `verify.mjs`.
- `WEEKLY.md`: ratio table updated to bible 90%/~27 and nonsense 10%/~3 (30-
  question basis); explains the fallback-to-other-category and capped-count-
  when-bank-is-small behavior; dropped the `general` row from the field table
  and the recommended-count line.
- `example-week.json`: replaced the 4 `general` sample questions with 3 new
  `bible` questions (one per... all 4 levels) with unique text not present in
  the real bank; still passes `--dry-run` validation without writing.

## `verify/verify.mjs`

- **Flaky score fix**: replaced the per-player `waitUntilInZone` + `Promise.all`
  pattern (which could pass each player's arrival check at a different tick,
  letting avatar-separation physics knock an earlier arrival back out of its
  zone before reveal) with a single `waitUntilAllInZones` helper that waits for
  one `positions` broadcast where *all* players are simultaneously inside their
  chosen zone, with a generous timeout (`ZONE_ARRIVAL_TIMEOUT_MS`: 10s local /
  20s remote) before calling `reveal`. The old single-player `waitUntilInZone`
  helper (now unused) was removed.
- **Category mix test**: now computes the elementary bank's actual pool size
  and nonsense count at runtime instead of asserting hardcoded 30/21/6/3; when
  the bank has no nonsense questions it asserts the whole game is bible-only,
  otherwise it asserts the nonsense share is within ±2 of the 10% target. It
  also asserts the game length equals `min(DEFAULT_QUESTION_COUNT, poolSize)`,
  covering the "capped, no error, no repeats" requirement for a level whose
  bank (18) is smaller than the default count (30).
- **Recent-avoidance test**: game size is now derived from the middle-level
  bank size (`min(10, floor(poolSize/2) - 1)`) instead of a hardcoded 10, so
  the test stays valid (guaranteed non-overlapping fresh margin) even if the
  bank shrinks further later. Comment/assert text no longer references the old
  30-question/general-era numbers.
- **New add-week test**: spawns `add-week.mjs --dry-run` on a file with
  `category: 'general'` and asserts non-zero exit and that stderr mentions
  `category`/`general`.
- `VERIFY_WS_URL` / remote timeout support unchanged.

## Verification performed

- `npm run build` — passes (`tsc` clean, `vite build` succeeds).
- `npm run verify` — passes, run **5 times** consecutively (clean 0-exit, "ALL
  CHECKS PASSED" every time), including the new capped-count/all-bible-fallback
  category assertions, the adaptive recent-avoidance test, the new
  `general`-rejection test, and no flakes from the zone-arrival/score fix.

No commit was made; the working tree (plus the pre-existing, untouched
`server/data/questions/2026-45.json` diff and the stray `.xlsx` file from the
owner) is left for review.
