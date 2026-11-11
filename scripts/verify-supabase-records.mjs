// Real-Supabase write/read/cleanup check for church records.
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
// Usage: node scripts/verify-supabase-records.mjs
import * as records from '../server/src/records.js';
import * as supabaseRecords from '../server/src/supabaseRecords.js';

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

if (!supabaseRecords.supabaseEnabled()) {
  console.error('SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.');
  process.exit(2);
}

const code = `sbtest${Date.now().toString(36)}`.slice(0, 20);
const pin = '2468';
const now = Date.parse('2026-11-11T11:00:00+09:00');

try {
  const created = records.openGroup(code, pin, { create: true, now });
  assert(created.created === true, '새 반 생성');
  records.claimNickname(code, { nickname: '검증사자', deviceId: 'dev-verify', now });
  const att = records.markAttendance(code, { nickname: '검증사자', now });
  assert(att.newlyMarked === true, '출석 기록');
  records.adjustTalent(code, { nickname: '검증사자', delta: 7, reason: '배포 검증', now });
  const key = records.nickKey('검증사자');
  const buy = records.buyItem(code, key, 'hat-melon', { now });
  assert(buy.charged === 7, '상점 구입');

  records._clearCache();
  const sum = records.groupSummary(code, { now });
  const member = sum.members.find((m) => m.nickname === '검증사자');
  assert(member && member.presentThisWeek, '캐시 비운 뒤에도 출석이 남아 있어야 함');
  assert(member.total === 0 && member.equipped.hat === 'hat-melon', '달란트·착용 정보가 다시 읽혀야 함');
  assert(sum.settings.weeklyCap === 20, '주간 상한 유지');
  assert(sum.ledger.some((e) => e.reason === '배포 검증' && e.delta === 7), '장부 유지');

  const row = supabaseRecords.loadClass(code);
  assert(row && row.code === code && row.members[key].owned.includes('hat-melon'), 'Supabase 문서에 저장됨');
  console.log('supabase records write+read ok');
} finally {
  try {
    supabaseRecords.deleteClass(code);
    records._clearCache();
    const gone = supabaseRecords.loadClass(code);
    if (gone) throw new Error('테스트 반이 아직 남아 있어요.');
    console.log('supabase records cleanup ok');
  } catch (err) {
    console.error('cleanup failed:', err.message);
    process.exit(1);
  }
}
