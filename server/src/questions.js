// 교회학교 OX 퀴즈 문항 로더
// 실제 문항 데이터는 DB가 아니라 server/data/questions/<YYYY-WW>.json (ISO 주차) 파일에
// 들어있고, 서버 시작 시 이 모듈이 그 디렉터리의 모든 파일을 읽어 메모리에 올려요.
// 각 문항: { id, level, category, text, answer, explanation, ref?, week }
//   - id: 전체 문항 뱅크에서 고유한 안정적인 문자열 id
//   - level: 'elementary' | 'middle' | 'high' | 'youth'
//   - category: 'bible' | 'nonsense'
//   - answer: 'O' | 'X'
//   - ref: 성경 출처(장:절) — category가 'bible'이면 필수
//   - week: 해당 문항이 추가된 주차 (YYYY-WW)
// 새 주차 문항을 추가하려면 scripts/add-week.mjs를 사용하세요 (docs/WEEKLY.md 참고).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, '../data/questions');

export const LEVELS = ['elementary', 'middle', 'high', 'youth'];

export const LEVEL_LABELS = {
  elementary: '초등',
  middle: '중등',
  high: '고등',
  youth: '청년',
};

export const DEFAULT_LEVEL = 'elementary';

export const CATEGORIES = ['bible', 'nonsense'];

export const CATEGORY_LABELS = {
  bible: '성경',
  nonsense: '넌센스',
};

// 호스트가 방을 만들 때 고를 수 있는 문제 수와, 카테고리를 섞는 기본 비율.
// 30문제 기준 대략 성경 27 / 넌센스 3에 맞춰져 있어요.
export const DEFAULT_QUESTION_COUNT = 30;
export const CATEGORY_RATIOS = { bible: 0.9, nonsense: 0.1 };

function loadAllQuestions() {
  const files = fs.existsSync(DATA_DIR)
    ? fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort()
    : [];
  const all = [];
  const seenIds = new Set();
  for (const file of files) {
    const full = path.join(DATA_DIR, file);
    const list = JSON.parse(fs.readFileSync(full, 'utf-8'));
    for (const q of list) {
      if (seenIds.has(q.id)) {
        throw new Error(`Duplicate question id "${q.id}" found while loading ${file}`);
      }
      if (!CATEGORIES.includes(q.category)) {
        throw new Error(`Invalid category "${q.category}" for question "${q.id}" in ${file} (allowed: ${CATEGORIES.join(', ')})`);
      }
      seenIds.add(q.id);
      all.push(q);
    }
  }
  return all;
}

export const ALL_QUESTIONS = loadAllQuestions();

export const QUESTIONS_BY_LEVEL = {};
export const QUESTIONS_BY_LEVEL_CATEGORY = {};
for (const level of LEVELS) {
  QUESTIONS_BY_LEVEL[level] = ALL_QUESTIONS.filter((q) => q.level === level);
  QUESTIONS_BY_LEVEL_CATEGORY[level] = {};
  for (const category of CATEGORIES) {
    QUESTIONS_BY_LEVEL_CATEGORY[level][category] = QUESTIONS_BY_LEVEL[level].filter((q) => q.category === category);
  }
}

// 난이도별 문제 은행 개수 (전체 + 카테고리별). 방 만들기 화면이 실제 개수를 보여 줄 때 쓴다.
// 반환: { elementary: { total, bible, nonsense }, ... } — 항상 로드된 은행에서 센다.
export function questionBankStats() {
  const stats = {};
  for (const level of LEVELS) {
    stats[level] = { total: QUESTIONS_BY_LEVEL[level].length };
    for (const category of CATEGORIES) {
      stats[level][category] = QUESTIONS_BY_LEVEL_CATEGORY[level][category].length;
    }
  }
  return stats;
}

// 기존 코드와의 호환을 위해 기본(초등) 문항 배열도 그대로 export
export const QUESTIONS = QUESTIONS_BY_LEVEL[DEFAULT_LEVEL];

export function normalizeLevel(level) {
  return LEVELS.includes(level) ? level : DEFAULT_LEVEL;
}

export function questionsForLevel(level) {
  return QUESTIONS_BY_LEVEL[normalizeLevel(level)];
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// total개의 문제를 카테고리 비율(CATEGORY_RATIOS)에 맞춰 나눈 개수를 돌려줘요.
// 반올림 오차는 가장 비중이 큰 'bible' 카테고리가 흡수해서 합이 항상 total이 되도록 해요.
export function categoryCounts(total) {
  const counts = {};
  let assigned = 0;
  for (const category of CATEGORIES) {
    counts[category] = Math.round(total * CATEGORY_RATIOS[category]);
    assigned += counts[category];
  }
  counts.bible += total - assigned;
  return counts;
}

// level의 문제 뱅크에서 count개를 카테고리 비율대로 뽑아요.
// - 어떤 카테고리가 모자라면 다른 카테고리(그리고 최종적으로는 같은 level의 전체 풀)에서
//   채워 넣어요 (요구사항: "fall back to other categories if a category runs short").
// - excludeIds에 들어있는 문제는 가능한 한 피하고, 그래도 개수가 모자라면 그제서야 사용해요
//   (최근에 낸 문제를 교회별로 피하기 위한 용도).
export function selectQuizQuestions({ level, count = DEFAULT_QUESTION_COUNT, excludeIds = new Set() } = {}) {
  const lvl = normalizeLevel(level);
  const pool = QUESTIONS_BY_LEVEL[lvl];
  const total = Math.max(0, Math.min(Math.round(count) || 0, pool.length));
  const desired = categoryCounts(total);

  const used = new Set();
  const picked = [];

  function takeFrom(list, n) {
    if (n <= 0) return 0;
    const remaining = list.filter((q) => !used.has(q.id));
    const fresh = shuffle(remaining.filter((q) => !excludeIds.has(q.id)));
    const stale = shuffle(remaining.filter((q) => excludeIds.has(q.id)));
    const take = [...fresh, ...stale].slice(0, n);
    for (const q of take) used.add(q.id);
    picked.push(...take);
    return n - take.length; // 못 채운 개수(shortfall)
  }

  let shortfall = 0;
  for (const category of CATEGORIES) {
    shortfall += takeFrom(QUESTIONS_BY_LEVEL_CATEGORY[lvl][category], desired[category]);
  }
  if (shortfall > 0) {
    takeFrom(pool, shortfall);
  }

  return shuffle(picked);
}
