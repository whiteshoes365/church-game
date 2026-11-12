# church-game Supabase

운영 기록은 무료 플랜 프로젝트(ref `dilqbdgzzgrhstcytonl`, 표시 이름은 대시보드에서 `church`로 바꿔 주세요)에 저장합니다.
찬양 튜너 기존 테이블은 `public`에 그대로 두고, 교회학교 게임 기록만 스키마 `church_game`에 둡니다.

적용된 마이그레이션:
- `church_game_records` — 처음 public.`church_*` 테이블 생성
- `church_sync_search_path` — 트리거 함수 search_path 고정
- `move_church_game_schema` — 테이블을 `church_game` 스키마로 옮기고 접두어를 제거 (`classes`, `members`, `attendance`, `talent_ledger`, `shop_items`, `games`)
- `20261112_question_reports` — 문제 신고(`question_reports`)와 검토/숨김(`question_reviews`). **운영 적용은 승인 후.** 검토 비밀번호는 서버 환경 변수 `QUESTION_REVIEW_PASSWORD`(값은 커밋하지 않음).

권한: RLS 켜짐, 정책 없음, 스키마/테이블 권한은 `service_role`과 `postgres`만.

Data API로 쓰려면 대시보드 Settings → API → Exposed schemas에 `church_game`을 추가해야 합니다. 서버는 `Accept-Profile`/`Content-Profile: church_game` 헤더를 씁니다.

서버는 `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`가 있을 때만 Supabase를 쓰고, 없으면 로컬 JSON 파일로 동작합니다(`npm run verify`는 오프라인).

실제 DB 검사: `npm run verify:supabase` (환경 변수 필요, 끝나면 테스트 행을 지웁니다).
