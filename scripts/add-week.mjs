#!/usr/bin/env node
// 새 주차(week) 문항 JSON 파일을 검증하고 server/data/questions/<week>.json 에 써줘요.
// 사용법: npm run add-week -- <file> [--dry-run]
// 자세한 설명은 docs/WEEKLY.md 를 참고하세요.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVELS, CATEGORIES, ALL_QUESTIONS } from '../server/src/questions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'server/data/questions');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const inputArg = args.find((a) => !a.startsWith('--'));

if (!inputArg) {
  console.error('사용법: npm run add-week -- <file> [--dry-run]');
  process.exit(1);
}

function fail(msg) {
  console.error(`[add-week] ERROR: ${msg}`);
}

function warn(msg) {
  console.warn(`[add-week] WARNING: ${msg}`);
}

const inputPath = path.resolve(process.cwd(), inputArg);

let raw;
try {
  raw = fs.readFileSync(inputPath, 'utf-8');
} catch (err) {
  fail(`파일을 읽을 수 없어요: ${err.message}`);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch (err) {
  fail(`올바른 JSON이 아니에요: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(data)) {
  fail('최상위 값은 문항 객체의 배열이어야 해요.');
  process.exit(1);
}

const errors = [];
const warnings = [];

const idsInFile = new Set();
const textsInFile = new Set();
const weeksSeen = new Set();

for (let i = 0; i < data.length; i++) {
  const q = data[i];
  const where = (label) => `item[${i}]${q && q.id ? ` (id="${q.id}")` : ''}: ${label}`;

  if (!q || typeof q !== 'object' || Array.isArray(q)) {
    errors.push(where('문항은 객체여야 해요.'));
    continue;
  }

  if (!q.id || typeof q.id !== 'string') {
    errors.push(where('id는 비어있지 않은 문자열이어야 해요.'));
  } else if (idsInFile.has(q.id)) {
    errors.push(where(`파일 안에서 id가 중복돼요: "${q.id}"`));
  } else {
    idsInFile.add(q.id);
  }

  if (!LEVELS.includes(q.level)) {
    errors.push(where(`level 값이 올바르지 않아요: "${q.level}" (허용: ${LEVELS.join(', ')})`));
  }

  if (!CATEGORIES.includes(q.category)) {
    errors.push(where(`category 값이 올바르지 않아요: "${q.category}" (허용: ${CATEGORIES.join(', ')})`));
  }

  if (!q.text || typeof q.text !== 'string') {
    errors.push(where('text는 비어있지 않은 문자열이어야 해요.'));
  } else if (textsInFile.has(q.text)) {
    errors.push(where('파일 안에서 text가 중복돼요.'));
  } else {
    textsInFile.add(q.text);
  }

  if (q.answer !== 'O' && q.answer !== 'X') {
    errors.push(where(`answer는 'O' 또는 'X'여야 해요 (받은 값: "${q.answer}")`));
  }

  if (!q.explanation || typeof q.explanation !== 'string') {
    errors.push(where('explanation은 비어있지 않은 문자열이어야 해요.'));
  }

  if (q.category === 'bible' && (!q.ref || typeof q.ref !== 'string')) {
    errors.push(where("category가 'bible'이면 ref(성경 출처)가 필수예요."));
  }

  if (!q.week || !/^\d{4}-\d{2}$/.test(q.week)) {
    errors.push(where("week는 'YYYY-WW' 형식이어야 해요 (예: '2026-45')."));
  } else {
    weeksSeen.add(q.week);
  }
}

if (weeksSeen.size > 1) {
  errors.push(`파일 안의 모든 문항은 같은 week 값을 가져야 해요. 발견된 값: ${[...weeksSeen].join(', ')}`);
}

const week = [...weeksSeen][0];

// 전체 문항 뱅크(기존에 로드된 모든 주차 파일) 대비 id/text 중복 확인
if (errors.length === 0) {
  const existingIds = new Set(ALL_QUESTIONS.map((q) => q.id));
  const existingTexts = new Set(ALL_QUESTIONS.map((q) => q.text));
  for (let i = 0; i < data.length; i++) {
    const q = data[i];
    if (existingIds.has(q.id)) {
      errors.push(`item[${i}]: id가 기존 문항 뱅크에 이미 있어요: "${q.id}"`);
    }
    if (existingTexts.has(q.text)) {
      errors.push(`item[${i}]: text가 기존 문항 뱅크에 이미 있어요: "${q.text}"`);
    }
  }
}

// 권장 개수(30문제 기준 성경21/상식6/넌센스3) 및 O/X 균형 - 경고만, 실패시키지 않음
if (errors.length === 0) {
  for (const level of LEVELS) {
    const forLevel = data.filter((q) => q.level === level);
    if (forLevel.length === 0) continue;
    const total = forLevel.length;

    const counts = { bible: 0, general: 0, nonsense: 0 };
    let oCount = 0;
    let xCount = 0;
    for (const q of forLevel) {
      if (counts[q.category] !== undefined) counts[q.category] += 1;
      if (q.answer === 'O') oCount += 1;
      else if (q.answer === 'X') xCount += 1;
    }

    const recommended = {
      bible: Math.round(total * 0.7),
      general: Math.round(total * 0.2),
      nonsense: Math.round(total * 0.1),
    };
    for (const category of CATEGORIES) {
      if (counts[category] < recommended[category]) {
        warnings.push(
          `level '${level}': ${category} 문항이 ${counts[category]}개로, 권장치(~${recommended[category]}개, ${total}문제 기준)보다 적어요.`,
        );
      }
    }

    if (Math.abs(oCount - xCount) > Math.ceil(total * 0.3)) {
      warnings.push(`level '${level}': O/X 균형이 치우쳐 있어요 (O=${oCount}, X=${xCount}).`);
    }
  }
}

if (errors.length > 0) {
  for (const e of errors) fail(e);
  console.error(`[add-week] ${errors.length}개의 오류가 있어 중단해요.`);
  process.exit(1);
}

for (const w of warnings) warn(w);

if (dryRun) {
  console.log(`[add-week] dry-run 통과: week ${week}, 문항 ${data.length}개 (파일을 쓰지는 않았어요).`);
  process.exit(0);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const targetPath = path.join(DATA_DIR, `${week}.json`);
let merged = data;
if (fs.existsSync(targetPath)) {
  const existing = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
  merged = [...existing, ...data];
}
fs.writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`[add-week] ${targetPath} 에 문항 ${data.length}개를 추가했어요. (해당 주차 총 ${merged.length}개)`);
process.exit(0);
