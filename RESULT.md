# RESULT

## 더 재미있게: 주별 출석 · 달란트 · 팀 대결 (2026-11-10, branch `wip/fun-features`)

**기능**
- **반 기록**: 호스트 홈에서 반 코드 + 교사 PIN(숫자 4~8자리)으로 열기/새로 만들기 → `/#/host/group/<반코드>` (출석부 / 달란트 / 게임 기록 탭).
- **주별 출석**: 반에 연결된 방에 입장하면 그 주(ISO 주, KST) 출석 1회. 이번 주 출석 카드 + 최근 8주 × 닉네임 표(합계·연속). 교사가 폰 없는 친구를 직접 출석 추가 가능.
- **달란트 장부**: 게임 종료 시 자동 지급, 교사 수동 +/-(사유 필수), 누적 순위표, 이름을 누르면 개인 내역.
- **팀 대결**: 방 만들 때 또는 대기실에서 켜기, 2~4팀(빨강 벽돌/파랑 얼음/초록 잔디/노랑 황금), 자동 균형 랜덤(인원 차 ≤1)·다시 섞기·이름 눌러 수동 이동, 게임 중 팀 점수 막대, 종료 시 3D 블록 단상 + 색종이 블록 결과 화면(이긴 팀/진 팀).
- **추가**: 연속 출석 배지(2주 연속·3주 철벽·5주 황금·8주 다이아), 이번 주 MVP(이번 주 달란트 최다), 게임 MVP(최고 득점), 팀 없는 게임도 1·2·3등 단상, 학생 화면에 우리 팀·출석·받은 달란트 표시.

**달란트 규칙** (`server/src/records.js` `TALENT_RULES`)
- 참가 +1 · 1/2/3등 +3/+2/+1 (동점은 같은 등수, 0점은 순위 보상 없음) · 만점 +2 (5문제 이상 게임만)
- 연속 출석 3주 이상이면 그 주 첫 출석 때 +1
- 팀 승리 보너스: 이긴 팀원 각자 +2 (교사가 0~5 조정). 팀 점수는 **팀원 평균 정답 수**로 비교(인원이 달라도 공평), 동률은 공동 우승으로 모두 보너스.
- 수동 조정은 1회 ±100 이내, 사유 필수. 모든 지급은 장부에 사유·주차와 함께 남음.

**데이터 · 보호**
- `server/data/church-records/<반코드>.json` (gitignore, `RECORDS_DIR` 로 변경 가능), 임시 파일 → rename 원자적 쓰기.
- 저장 항목은 닉네임·블록 아바타 코드·출석 주차·달란트 내역뿐. 실명/연락처/생일 없음. PIN 은 scrypt 해시만 저장.
- 반 조회·수정·방 연결은 PIN 인증된 소켓만 가능(5회 틀리면 1분 잠금). 팀 설정은 호스트 소켓만.

**검증**
- `npm run build` 통과 (tsc + vite). `npm run verify` 통과 — 최종 코드로 4회, 그 직전(화면 다듬기 전) 8회 연속 실행 전부 `ALL CHECKS PASSED`. 기존 검사 전부 유지.
- 추가된 검사: KST 주 경계, 출석 1주 1회, 연속 출석/배지/보너스, 자동 지급 규칙, 수동 가감·사유 검증, PIN 보호, 파일 저장, 팀 자동/수동 배정, 게임 중 팀 점수, 이긴 팀/진 팀/무승부, 팀 보너스 장부 기록, 중복 지급 없음.

**스크린샷** `/workspace/church-ox-screenshots/` — `w1280-*`, `w1920-*` 각 8장 (Playwright, 데모 데이터)
- `host-home`, `attendance`, `talent-leaderboard`, `talent-person-history`, `team-lobby`, `team-playing`, `team-result`, `games`

**알려진 한계**
- 1280×720 결과 화면에서 이름표가 일부 겹치고, 하단 팀 카드가 단상 앞면을 가림 (1920×1080 은 문제 없음).
- 호스트 방 화면을 한 화면 고정 높이로 바꿈(폭 900px 이하는 기존처럼 스크롤). 대기실 아바타를 한 점 대신 한 줄로 세움.

**확인이 필요한 것**
1. 같은 닉네임 = 같은 사람으로 봅니다. 반에 동명 닉네임이 있으면 기록이 합쳐져요. 닉네임을 매주 바꾸면 다른 사람으로 기록돼요. 이대로 괜찮을까요?
2. 출석 기준이 "방 입장"입니다(게임을 끝까지 안 해도 출석). "게임 완료"로 바꿀까요?
3. 한 주에 여러 판을 하면 판마다 달란트가 지급됩니다. 주당 상한이 필요할까요?
4. 방 호스트 화면은 방 ID 만 알면 열 수 있습니다(기존 동작). 반 기록은 PIN 으로 보호되지만 방 자체도 PIN 으로 묶을까요?
5. 달란트 사용(간식 교환 등)은 지금은 수동 차감으로만 처리합니다. 전용 "교환" 버튼이 필요할까요?

---

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
