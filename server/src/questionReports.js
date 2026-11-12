// 문제 신고 · 자동 숨김 · 검토 저장소.
//
// - 문항 자체(server/data/questions/*.json)는 건드리지 않는다. 신고·숨김·수정 제안은 별도 저장소에만 둔다.
// - 운영: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 가 있으면 church_game.question_reports / question_reviews
//   (supabase/migrations/ 의 추가 마이그레이션이 먼저 적용돼 있어야 한다).
// - 로컬/검증: 없으면 RECORDS_DIR/_question-reports/reports.json (원자적 쓰기).
// - 개인정보 최소화: 역할(host|student)·사유·짧은 메모·변환된 기기값만 저장한다.
//   닉네임·방 PIN·원문 기기 id·IP·교회·방 정보는 저장하지 않는다.
// - 저장소를 못 읽어도(마이그레이션 전, 네트워크 오류) 게임은 멈추지 않는다: 숨김 없이 진행하고 신고만 실패한다.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { recordsDir } from './records.js';
import { supabaseEnabled, request } from './supabaseRecords.js';
import { getQuestionById } from './questions.js';

// ---- 규칙 (verify 가 값을 검사한다) ----
export const REPORT_HIDE_DEVICE_THRESHOLD = 3; // 서로 다른 기기 N대가 신고하면 자동 숨김
export const REPORT_MEMO_MAX = 200; // 메모 글자 수 상한 (서버에서도 강제)
export const REPORT_REASONS = ['wrong_answer', 'ambiguous', 'inappropriate', 'typo', 'other'];
export const REPORT_REASON_LABELS = {
  wrong_answer: '틀린 답',
  ambiguous: '애매함',
  inappropriate: '부적절',
  typo: '오타',
  other: '기타',
};
export const REPORT_ROLES = ['host', 'student'];
const SUGGESTION_FIELD_MAX = 1000;
export const REVIEW_PASSWORD_ENV = 'QUESTION_REVIEW_PASSWORD';

// 기기 id 는 그대로 저장하지 않는다. 문항 id 와 섞어 한 방향으로 바꾼 값만 남긴다.
// (문항마다 값이 달라서, 저장된 값으로는 "같은 기기가 다른 문항도 신고했는지"조차 이어 볼 수 없다.
//  쓰임새는 "같은 기기가 같은 문항을 두 번 신고하지 못하게" 하나뿐이다.)
export function reportDeviceHash(questionId, deviceId) {
  return createHash('sha256').update(`question-report:${questionId}:${deviceId}`).digest('hex').slice(0, 32);
}

// ---- 메모리 상태 ----
// reports: [{ id, questionId, role, reason, memo, deviceHash, createdAt }]
// reviews: questionId -> { hidden: boolean, suggestion: object|null, action, reviewedAt }
let state = null;
let loadError = null;
let lastLoadAttempt = 0;
const RETRY_LOAD_MS = 30000;

function localFile() {
  return path.join(recordsDir(), '_question-reports', 'reports.json');
}

function emptyState() {
  return { reports: [], reviews: new Map() };
}

function loadLocal() {
  const file = localFile();
  if (!fs.existsSync(file)) return emptyState();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    reports: Array.isArray(raw.reports) ? raw.reports : [],
    reviews: new Map(Object.entries(raw.reviews || {})),
  };
}

function saveLocal() {
  const file = localFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ reports: state.reports, reviews: Object.fromEntries(state.reviews) }, null, 1));
  fs.renameSync(tmp, file);
}

function loadRemote() {
  const reports = request({
    method: 'GET',
    path: 'question_reports?select=id,question_id,role,reason,memo,device_hash,created_at&order=created_at.asc&limit=5000',
  });
  const reviews = request({
    method: 'GET',
    path: 'question_reviews?select=question_id,hidden,suggestion,action,reviewed_at&limit=5000',
  });
  if (!Array.isArray(reports) || !Array.isArray(reviews)) throw new Error('문제 신고 저장소 응답이 올바르지 않아요.');
  return {
    reports: reports.map((r) => ({
      id: r.id,
      questionId: r.question_id,
      role: r.role,
      reason: r.reason,
      memo: r.memo || '',
      deviceHash: r.device_hash,
      createdAt: Date.parse(r.created_at) || 0,
    })),
    reviews: new Map(
      reviews.map((r) => [
        r.question_id,
        { hidden: !!r.hidden, suggestion: r.suggestion ?? null, action: r.action ?? null, reviewedAt: Date.parse(r.reviewed_at) || 0 },
      ]),
    ),
  };
}

function tryLoad() {
  lastLoadAttempt = Date.now();
  try {
    state = supabaseEnabled() ? loadRemote() : loadLocal();
    loadError = null;
  } catch (err) {
    loadError = err;
    console.error('[question-reports] 신고 저장소를 읽지 못했어요 (숨김 없이 계속 진행):', err.message);
  }
}

// 게임 진행 경로(문제 선정·은행 개수)에서 부른다: 처음 한 번만 읽고, 실패해도 다시 시도하느라 멈추지 않는다.
function current() {
  if (!state && lastLoadAttempt === 0) tryLoad();
  return state;
}

// 신고·검토 경로에서 부른다: 저장소가 없으면(읽기 실패) 잠시 뒤 다시 읽어 보고, 그래도 안 되면 오류.
function requireState({ refresh = false } = {}) {
  if (refresh && supabaseEnabled()) tryLoad();
  else if (!state && (lastLoadAttempt === 0 || Date.now() - lastLoadAttempt > RETRY_LOAD_MS)) tryLoad();
  if (!state || (refresh && loadError)) throw new Error('문제 신고 저장소를 쓸 수 없어요. 잠시 뒤 다시 시도해 주세요.');
  return state;
}

/** 서버가 켜질 때 한 번 미리 읽어 둔다 (수업 중 첫 문제 선정이 저장소 읽기를 기다리지 않게). */
export function preloadQuestionReports() {
  current();
}

// ---- 숨김 규칙 ----
function reportsFor(st, questionId) {
  return st.reports.filter((r) => r.questionId === questionId);
}

// 반환: null(숨기지 않음) | 'review'(검토에서 숨김) | 'host'(선생님 신고) | 'devices'(기기 N대 신고)
function hiddenReason(st, questionId, reports = reportsFor(st, questionId)) {
  if (st.reviews.get(questionId)?.hidden) return 'review';
  if (reports.some((r) => r.role === 'host')) return 'host';
  if (new Set(reports.map((r) => r.deviceHash)).size >= REPORT_HIDE_DEVICE_THRESHOLD) return 'devices';
  return null;
}

/** 새 방 문제 선정에서 강하게 제외할 문항 id 집합. 저장소를 못 읽었으면 빈 집합. */
export function hiddenQuestionIds() {
  const st = current();
  const out = new Set();
  if (!st) return out;
  const ids = new Set(st.reports.map((r) => r.questionId));
  for (const [id, review] of st.reviews) if (review.hidden) ids.add(id);
  for (const id of ids) if (hiddenReason(st, id)) out.add(id);
  return out;
}

export function isQuestionHidden(questionId) {
  return hiddenQuestionIds().has(questionId);
}

// ---- 신고 ----
function cleanMemo(memo) {
  if (memo === undefined || memo === null) return '';
  if (typeof memo !== 'string') throw new Error('메모는 글자로 적어 주세요.');
  const m = memo.replace(/\s+/g, ' ').trim();
  // 글자 수는 코드 포인트로 센다 (한글·이모지도 1자).
  if ([...m].length > REPORT_MEMO_MAX) throw new Error(`메모는 ${REPORT_MEMO_MAX}자까지 쓸 수 있어요.`);
  return m;
}

/**
 * 신고 1건 저장. 같은 기기가 같은 문항을 이미 신고했으면 저장하지 않고 { duplicate: true }.
 * 반환: { ok, duplicate, hidden } — hidden 은 이 신고 뒤 그 문항이 새 방에서 숨겨지는지.
 */
export function addQuestionReport({ questionId, role, reason, memo, deviceId, now = Date.now() }) {
  if (typeof questionId !== 'string' || !getQuestionById(questionId)) throw new Error('신고할 문제를 찾을 수 없어요.');
  if (!REPORT_ROLES.includes(role)) throw new Error('신고할 수 없는 접속이에요.');
  if (!REPORT_REASONS.includes(reason)) throw new Error('신고 사유를 골라 주세요.');
  if (typeof deviceId !== 'string' || deviceId.length < 4 || deviceId.length > 200) throw new Error('기기 정보를 확인할 수 없어요. 새로고침 후 다시 시도해 주세요.');
  const cleanedMemo = cleanMemo(memo);
  const st = requireState();
  const deviceHash = reportDeviceHash(questionId, deviceId);
  if (st.reports.some((r) => r.questionId === questionId && r.deviceHash === deviceHash)) {
    return { ok: false, duplicate: true, hidden: !!hiddenReason(st, questionId) };
  }
  const report = { id: randomUUID(), questionId, role, reason, memo: cleanedMemo, deviceHash, createdAt: now };
  if (supabaseEnabled()) {
    request({
      method: 'POST',
      path: 'question_reports',
      body: [
        {
          id: report.id,
          question_id: questionId,
          role,
          reason,
          memo: cleanedMemo,
          device_hash: deviceHash,
          created_at: new Date(now).toISOString(),
        },
      ],
    });
    st.reports.push(report);
  } else {
    st.reports.push(report);
    try {
      saveLocal();
    } catch (err) {
      st.reports.pop();
      throw err;
    }
  }
  return { ok: true, duplicate: false, hidden: !!hiddenReason(st, questionId) };
}

// ---- 검토 비밀번호 ----
// 비밀번호는 서버 환경 변수에만 있다. 비어 있으면 검토 기능 전체가 닫힌다 (기본 비밀번호 없음).
export function reviewPasswordConfigured() {
  return typeof process.env[REVIEW_PASSWORD_ENV] === 'string' && process.env[REVIEW_PASSWORD_ENV].length > 0;
}

export function checkReviewPassword(supplied) {
  if (!reviewPasswordConfigured()) return false;
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(process.env[REVIEW_PASSWORD_ENV]).digest();
  return timingSafeEqual(a, b);
}

// ---- 검토 ----
function saveReview(st, questionId, review) {
  if (supabaseEnabled()) {
    request({
      method: 'POST',
      path: 'question_reviews?on_conflict=question_id',
      body: [
        {
          question_id: questionId,
          hidden: review.hidden,
          suggestion: review.suggestion,
          action: review.action,
          reviewed_at: new Date(review.reviewedAt).toISOString(),
        },
      ],
    });
    st.reviews.set(questionId, review);
    return;
  }
  const before = st.reviews.get(questionId);
  st.reviews.set(questionId, review);
  try {
    saveLocal();
  } catch (err) {
    if (before) st.reviews.set(questionId, before);
    else st.reviews.delete(questionId);
    throw err;
  }
}

function cleanSuggestion(input) {
  if (!input || typeof input !== 'object') throw new Error('수정 제안 내용을 적어 주세요.');
  const field = (v, label) => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') throw new Error(`${label}은(는) 글자로 적어 주세요.`);
    const t = v.trim();
    if ([...t].length > SUGGESTION_FIELD_MAX) throw new Error(`${label}은(는) ${SUGGESTION_FIELD_MAX}자까지 쓸 수 있어요.`);
    return t;
  };
  const out = {};
  const text = field(input.text, '문제');
  const explanation = field(input.explanation, '해설');
  const ref = field(input.ref, '출처');
  const note = field(input.note, '메모');
  if (text) out.text = text;
  if (input.answer === 'O' || input.answer === 'X') out.answer = input.answer;
  else if (input.answer !== undefined && input.answer !== null && input.answer !== '') throw new Error('정답은 O 또는 X 로 골라 주세요.');
  if (explanation) out.explanation = explanation;
  if (ref) out.ref = ref;
  if (note) out.note = note;
  if (Object.keys(out).length === 0) throw new Error('수정 제안 내용을 적어 주세요.');
  return out;
}

/**
 * 검토 액션. 비밀번호 확인은 부르는 쪽(index.js)에서 끝낸 뒤에 부른다.
 *  - keep    : 그 문항 신고를 비우고 숨김 해제 → 새 방에 다시 나올 수 있다 (수정 제안은 남긴다)
 *  - hide    : 신고 수와 상관없이 숨김 (신고는 그대로 둔다)
 *  - suggest : 수정 제안을 저장만 한다 (문항 JSON 은 고치지 않는다). suggestion: null 이면 제안 삭제
 */
export function applyReviewAction({ questionId, action, suggestion, now = Date.now() }) {
  if (typeof questionId !== 'string' || questionId.length === 0 || questionId.length > 120) throw new Error('문항 id 가 올바르지 않아요.');
  const st = requireState();
  const known = !!getQuestionById(questionId) || st.reviews.has(questionId) || st.reports.some((r) => r.questionId === questionId);
  if (!known) throw new Error('문항을 찾을 수 없어요.');
  const prev = st.reviews.get(questionId) || { hidden: false, suggestion: null, action: null, reviewedAt: 0 };
  if (action === 'keep') {
    // 먼저 "숨김 아님"을 저장하고, 그다음 신고를 지운다. 지우기에 실패하면 신고가 남아 계속 숨겨지므로 안전한 쪽으로 실패한다.
    saveReview(st, questionId, { ...prev, hidden: false, action: 'keep', reviewedAt: now });
    if (supabaseEnabled()) {
      request({ method: 'DELETE', path: `question_reports?question_id=eq.${encodeURIComponent(questionId)}` });
      st.reports = st.reports.filter((r) => r.questionId !== questionId);
    } else {
      const before = st.reports;
      st.reports = st.reports.filter((r) => r.questionId !== questionId);
      try {
        saveLocal();
      } catch (err) {
        st.reports = before;
        throw err;
      }
    }
  } else if (action === 'hide') {
    saveReview(st, questionId, { ...prev, hidden: true, action: 'hide', reviewedAt: now });
  } else if (action === 'suggest') {
    const cleaned = suggestion === null ? null : cleanSuggestion(suggestion);
    saveReview(st, questionId, { ...prev, suggestion: cleaned, action: prev.action, reviewedAt: now });
  } else {
    throw new Error('알 수 없는 검토 동작이에요.');
  }
  return reviewItem(st, questionId);
}

function questionView(questionId) {
  const q = getQuestionById(questionId);
  if (!q) return null;
  return { id: q.id, level: q.level, category: q.category, text: q.text, answer: q.answer, explanation: q.explanation ?? null, ref: q.ref ?? null, week: q.week ?? null };
}

function reviewItem(st, questionId) {
  const reports = reportsFor(st, questionId);
  const review = st.reviews.get(questionId) || null;
  const reasonCounts = Object.fromEntries(REPORT_REASONS.map((r) => [r, 0]));
  for (const r of reports) reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1;
  const why = hiddenReason(st, questionId, reports);
  return {
    questionId,
    question: questionView(questionId), // 은행에서 이미 지운 문항이면 null
    reportCount: reports.length,
    deviceCount: new Set(reports.map((r) => r.deviceHash)).size,
    hostReported: reports.some((r) => r.role === 'host'),
    reasonCounts,
    // 변환된 기기값도 화면으로는 내보내지 않는다.
    memos: reports.filter((r) => r.memo).map((r) => ({ role: r.role, reason: r.reason, memo: r.memo, createdAt: r.createdAt })),
    lastReportAt: reports.reduce((m, r) => Math.max(m, r.createdAt || 0), 0),
    hidden: !!why,
    hiddenBy: why,
    suggestion: review?.suggestion ?? null,
    lastAction: review?.action ?? null,
    reviewedAt: review?.reviewedAt || null,
  };
}

/** 검토 페이지 목록: 신고가 있거나, 검토에서 숨겼거나, 수정 제안이 있는 문항을 문항별로 묶는다. */
export function listReviewItems({ refresh = false } = {}) {
  const st = requireState({ refresh });
  const ids = new Set(st.reports.map((r) => r.questionId));
  for (const [id, review] of st.reviews) if (review.hidden || review.suggestion) ids.add(id);
  const items = [...ids].map((id) => reviewItem(st, id));
  // 신고가 있는 문항 먼저(최근 신고 순), 그다음 검토만 남은 문항.
  items.sort((a, b) => (b.reportCount > 0) - (a.reportCount > 0) || b.lastReportAt - a.lastReportAt || (b.reviewedAt || 0) - (a.reviewedAt || 0));
  return {
    items,
    threshold: REPORT_HIDE_DEVICE_THRESHOLD,
    memoMax: REPORT_MEMO_MAX,
    reasonLabels: REPORT_REASON_LABELS,
    hiddenCount: items.filter((i) => i.hidden).length,
  };
}

/**
 * 사람이 나중에 server/data/questions/*.json 에 반영하기 쉬운 형태로 내보낸다.
 * 서버는 문항 파일을 직접 고치지 않는다.
 */
export function exportReviewPatch({ now = Date.now() } = {}) {
  const { items } = listReviewItems();
  const fileOf = (q) => (q?.week ? `server/data/questions/${q.week}.json` : null);
  return {
    kind: 'church-game-question-review-export',
    version: 1,
    exportedAt: new Date(now).toISOString(),
    note: '이 파일은 제안일 뿐이에요. 문항 JSON(server/data/questions/<주차>.json)은 사람이 직접 고치거나 지워 주세요.',
    suggestions: items
      .filter((i) => i.suggestion)
      .map((i) => {
        const { note, ...changes } = i.suggestion;
        return {
          id: i.questionId,
          file: fileOf(i.question),
          current: i.question ? { text: i.question.text, answer: i.question.answer, explanation: i.question.explanation, ref: i.question.ref } : null,
          changes, // 바꿀 필드만 (text / answer / explanation / ref)
          note: note ?? null,
        };
      }),
    hidden: items
      .filter((i) => i.hidden)
      .map((i) => ({ id: i.questionId, file: fileOf(i.question), hiddenBy: i.hiddenBy, reportCount: i.reportCount, reasonCounts: i.reasonCounts, text: i.question?.text ?? null })),
  };
}

// verify 전용: 메모리 상태를 버리고 저장소에서 다시 읽게 한다.
export function _resetQuestionReports() {
  state = null;
  loadError = null;
  lastLoadAttempt = 0;
}
