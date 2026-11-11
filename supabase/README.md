# church-game Supabase

운영 기록(출석·달란트 장부·상점·닉네임 주인·교사 PIN 해시·주간 상한)은 무료 플랜 프로젝트 `worship-song-tuner`(`dilqbdgzzgrhstcytonl`)에 저장합니다.

적용된 마이그레이션:
- `church_game_records` — `church_classes`와 하위 테이블, RLS(정책 없음), anon/authenticated 권한 없음
- `church_sync_search_path` — 트리거 함수 search_path 고정

서버는 `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`가 있을 때만 Supabase를 쓰고, 없으면 로컬 JSON 파일로 동작합니다(`npm run verify`는 오프라인).

실제 DB 검사: `node scripts/verify-supabase-records.mjs` (환경 변수 필요, 끝나면 테스트 행을 지웁니다).
