#!/usr/bin/env node
// Generate draft O/X questions with Gemini free tier.
// Weekly (default): review/gemini_초안_<week>.json
//   npm run gen-gemini [-- --per-level 8 --model gemini-flash-lite-latest --week 2026-46]
// Bulk (~300, quality pass):
//   node scripts/gen-questions-gemini.mjs --target 300 --qa --out review/ox_quiz_300_2026-11-05.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; }));
const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY (or GOOGLE_API_KEY) env var is required.'); process.exit(2); }

const MODELS = [
  args.model || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
  'gemini-flash-lite-latest',
  'gemini-flash-latest',
].filter((m, i, a) => a.indexOf(m) === i);

const PER_LEVEL = Number(args['per-level'] || 8);
const TARGET = Number(args.target || 0);
const DO_QA = Boolean(args.qa) || TARGET > 0;
const DELAY_MS = Number(process.env.GEMINI_DELAY_MS || (TARGET ? 12000 : 15000));
const MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 2);
const LEVELS = {
  elementary: '초등학생(유명한 이야기, 쉬운 말, 짧은 문장)',
  middle: '중학생(인물·장소·사건, 조금 더 구체적인 본문 사실)',
  high: '고등학생(세부 내용·성경 각 권·배경·숫자와 지명)',
  youth: '청년(연대·상호참조·성경 각 권의 본문상 사실, 쉬운 해석 쟁점 없이)',
};
const LEVEL_KEYS = (args.levels ? String(args.levels).split(',') : Object.keys(LEVELS));
const CATS = ['bible', 'church', 'current', 'science', 'korean'];
const CAT_LABEL = { bible: '성경', church: '교회 절기', current: '시사', science: '우리 몸과 자연', korean: '우리말' };

function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear(); const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-${String(w).padStart(2, '0')}`;
}
const WEEK = args.week || isoWeek();

const STYLE_GUIDE = `
운영자가 직접 통과/삭제한 초등 성경 문제(스타일 지침):
통과(이런 느낌을 유지):
- [O] 가인은 동생 아벨을 미워해서 죽였어요. (본문의 분명한 사건, 쉬운 말)
- [O] 에서는 팥죽 한 그릇과 바꿔 자기의 장자권을 동생 야곱에게 넘겨주었어요. (구체적인 세부 사실)
- [O] 삼손은 맨손으로 사자를 찢어 죽인 적이 있어요. (잘 알려졌지만 구체적인 행동)
- [X] 드보라는 이스라엘의 왕이 되어 백성을 다스렸어요. (흔한 혼동을 바로잡는 X 문제, 실제로는 사사)
- [O] 다니엘은 사자 굴에 던져졌지만 하나님이 지켜주셨어요. (핵심이 분명한 이야기)
삭제(이런 문제는 만들지 말 것):
- [O] 노아는 하나님의 말씀을 듣고 큰 배(방주)를 만들었어요. → 괄호로 단어를 풀어 주는 유아적 표현, 너무 상투적인 한 줄
- [X] 하나님은 사람(아담)을 흙이 아니라 나무로 만드셨어요. → 웃자고 내는 대조·말장난
- [X] 아브라함은 조카 롯과 함께 떠나지 않고 혼자서만 고향을 떠났어요. → 이중부정·꼬인 문장
- [O] 모세는 아기일 때 갈대 상자에 담겨 나일강에 띄워졌어요. → 너무 상투적인 한 줄(유명 장면만 반복)
- [X] 이스라엘 백성은 배를 타고 홍해를 건넜어요. → 빤한 가짜 장면처럼 느껴지는 문제
`;

const RULES = `
규칙:
- 성경 문제는 본문에 적힌 사실만(교리·해석·교파 쟁점 금지). 개역개정 이름(다메섹, 바로, 블레셋, 여호와 등)과 장:절을 ref와 해설 첫머리에 적기.
- 흔한 오해 금지(에덴의 사과, 동방박사 3명, 요나의 고래, 노아 방주의 동물 한 쌍만 등). 정답이 분명히 O 또는 X여야 함.
- '항상/가장/처음/모두/유일한'은 본문이나 분명한 사실에 그대로 있을 때만.
- 상식퀴즈(세계 최대 바다, 에베레스트 높이, 잡학사전형) 금지. 넌센스·말장난·'웃자고' 내는 문제 금지. 논란·정치 이슈 금지.
- 시사(current)는 날짜·연도가 있는 변하지 않는 사실만(기념일, 역사적 연도). 순위·기록·최근 뉴스·정치인 평가 금지.
- 교회 절기(church)는 교단 무관한 보편 절기(대림/대강, 성탄, 주현, 사순, 종려, 고난주간, 부활, 승천, 성령강림, 삼위일체, 추수감사, 종교개혁기념일 등).
- 우리 몸과 자연(science)은 인체·식물·동물·계절·날씨 등 학교에서도 다루는 분명한 사실.
- 우리말(korean)은 순우리말/한자어 구분, 단어 뜻, 맞춤법의 확정된 사실. 말장난 금지.
- O와 X를 절반씩. 해설은 한국어 1~2문장(영어 단어 삽입 금지). 비성경 문제의 ref는 출처를 짧게(예: 대한민국 법정 공휴일, 고등학교 생명과학) 또는 빈 문자열.
- 문장은 자연스러운 한국어 한 문장. 괄호로 단어를 풀어 쓰지 말 것. 이중부정 금지.
- 이미 나온 문제와 같은 사실·같은 구절을 다시 묻지 말 것.
`;

function norm(s) {
  return String(s).replace(/[\s'"“”‘’.,!?~·()（）\[\]0-9]/g, '');
}

const bank = [];
const qdir = path.join(ROOT, 'server/data/questions');
if (fs.existsSync(qdir)) {
  for (const f of fs.readdirSync(qdir).filter((f) => f.endsWith('.json'))) {
    const d = JSON.parse(fs.readFileSync(path.join(qdir, f), 'utf8'));
    bank.push(...(Array.isArray(d) ? d : d.questions || []));
  }
}
const deleted = [];
const decPath = path.join(ROOT, 'review/decisions.json');
if (fs.existsSync(decPath)) {
  const dec = JSON.parse(fs.readFileSync(decPath, 'utf8'));
  const entries = Array.isArray(dec)
    ? dec.map((e) => [e.id, e.decision || e.status, e.text])
    : Object.entries(dec).map(([id, v]) => [id, typeof v === 'string' ? v : v.decision || v.status, v?.text]);
  const drafts = {};
  const revDir = path.join(ROOT, 'review');
  if (fs.existsSync(revDir)) {
    for (const f of fs.readdirSync(revDir).filter((f) => f.endsWith('.json') && f !== 'decisions.json')) {
      try {
        const a = JSON.parse(fs.readFileSync(path.join(revDir, f), 'utf8'));
        if (Array.isArray(a)) a.forEach((q) => { if (q.id) drafts[q.id] = q.text; });
      } catch { /* ignore broken draft */ }
    }
  }
  for (const [id, st, text] of entries) {
    if (/^(delete|삭제)$/i.test(String(st))) {
      const t = text || drafts[id];
      if (t) deleted.push(t);
    }
  }
}
const seen = new Set([...bank.map((q) => norm(q.text)), ...deleted.map(norm)]);

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      category: { type: 'STRING', enum: CATS },
      text: { type: 'STRING' },
      answer: { type: 'STRING', enum: ['O', 'X'] },
      explanation: { type: 'STRING' },
      ref: { type: 'STRING' },
    },
    required: ['category', 'text', 'answer', 'explanation', 'ref'],
  },
};

const QA_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      index: { type: 'INTEGER' },
      verdict: { type: 'STRING', enum: ['ok', 'fix', 'drop'] },
      reason: { type: 'STRING' },
      text: { type: 'STRING' },
      answer: { type: 'STRING', enum: ['O', 'X'] },
      explanation: { type: 'STRING' },
      ref: { type: 'STRING' },
    },
    required: ['index', 'verdict', 'reason'],
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(model, body) {
  for (let i = 0; i <= MAX_RETRIES; i++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    }).catch((e) => ({ ok: false, status: 599, text: async () => String(e) }));
    if (res.ok) return res.json();
    const txt = await res.text();
    if (res.status === 429 || res.status >= 500) {
      const m = txt.match(/"retryDelay":\s*"(\d+)s"/);
      const wait = m ? Number(m[1]) * 1000 + 1000 : Math.min(4000 * 2 ** i, 20000);
      if (/PerDay|per day|daily/i.test(txt) && res.status === 429) {
        throw Object.assign(new Error('daily quota exhausted'), { daily: true });
      }
      console.warn(`[gen] ${model} ${res.status}, retry ${i + 1}/${MAX_RETRIES} in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    throw new Error(`${model} HTTP ${res.status}: ${txt.slice(0, 280)}`);
  }
  throw new Error(`${model}: retries exhausted`);
}

async function generateWithFallback(body) {
  let lastErr;
  for (const model of MODELS) {
    try {
      const data = await call(model, body);
      return { data, model };
    } catch (e) {
      lastErr = e;
      console.warn(`[gen] model ${model} failed: ${e.message}`);
      if (e.daily) continue;
    }
  }
  throw lastErr || new Error('all models failed');
}

function parseArray(data) {
  const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '[]';
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const arr = JSON.parse(cleaned);
  if (!Array.isArray(arr)) throw new Error('not an array');
  return arr;
}

function validate(q) {
  const errs = [];
  if (!CATS.includes(q.category)) errs.push('category');
  if (!['O', 'X'].includes(q.answer)) errs.push('answer');
  if (!q.text || q.text.length < 8) errs.push('text');
  if (!q.explanation) errs.push('explanation');
  if (q.category === 'bible' && !q.ref) errs.push('ref');
  if (/웃자고|넌센스|말장난/.test(q.text + q.explanation)) errs.push('joke');
  if (/아니라 .+로 만들|배를 타고 홍해|큰 배\(방주\)|갈대 상자/.test(q.text)) errs.push('banned-style');
  if (seen.has(norm(q.text))) errs.push('duplicate');
  return errs;
}

function assignId(q, bucket, week) {
  const n = bucket.filter((x) => x.level === q.level).length + 1;
  q.id = `${q.level}-${q.category}-g${String(week).replace('-', '')}-${String(n).padStart(3, '0')}`;
  return q;
}

function weeklyPrompt(level, avoid) {
  const nb = Math.round(PER_LEVEL * 0.7);
  return `교회학교 OX 퀴즈 문제를 ${PER_LEVEL}개 만들어 주세요. 대상: ${LEVELS[level]}.
구성: 성경(bible) ${nb}개, 나머지 ${PER_LEVEL - nb}개는 church(교회 절기·기독교 문화, 교단 무관), current(시사: 변하지 않는 사실·연도/날짜 포함, 정치·논란·순위·기록 금지), science(인체·자연), korean(우리말) 중에서 골고루.
${STYLE_GUIDE}
${RULES}
- 아래 기존/삭제된 문제와 같은 사실을 묻지 말 것:
${avoid.map((t) => '- ' + t).join('\n')}`;
}

const BULK_BATCHES = [
  {
    id: 'ot-torah',
    cats: ['bible'],
    n: 16,
    focus: '구약 오경(창세기~신명기). 족장 이야기, 출애굽, 광야, 율법의 본문상 구체적 사실(숫자·지명·행동·대화). 노아의 방주/모세 갈대 상자처럼 상투적인 한 줄은 피하세요.',
  },
  {
    id: 'ot-history',
    cats: ['bible'],
    n: 16,
    focus: '구약 역사서(여호수아~에스더). 정복, 사사, 왕국, 포로와 귀환의 본문상 사실. 다윗과 골리앗의 대략적 한 줄보다는 본문의 구체적인 세부 사실을 물으세요.',
  },
  {
    id: 'ot-wisdom-prophets',
    cats: ['bible'],
    n: 14,
    focus: '구약 시가서·선지서(욥기~말라기). 시편·잠언의 적힌 표현, 주요 선지자의 본문상 사건·환상·예언의 사실(교리적 해석 없이).',
  },
  {
    id: 'nt-gospels',
    cats: ['bible'],
    n: 16,
    focus: '사복음서. 예수님의 생애·비유·기적·수난과 부활의 본문상 사실. 동방박사 세 명, 에덴의 사과 같은 본문에 없는 전설은 쓰지 마세요.',
  },
  {
    id: 'nt-acts-epistles',
    cats: ['bible'],
    n: 14,
    focus: '사도행전·서신서·요한계시록의 본문에 적힌 사실(인물, 지명, 여행, 편지 수신 대상, 환상에서 본 것). 교리 논쟁 문항 금지.',
  },
  {
    id: 'church-current',
    cats: ['church', 'current'],
    n: 16,
    focus: 'church 8개(대림/대강, 성탄, 주현, 사순, 종려, 고난주간, 부활, 승천, 성령강림, 삼위일체, 추수감사, 종교개혁기념일 등 보편 절기)와 current 8개(한글날·광복절·제헌절·삼일절 등 날짜가 있는 변하지 않는 사실, 또는 보편적 공공 제도의 확정된 연도). 정치·논란·순위 금지. 일반 상식잡학 금지.',
  },
  {
    id: 'science-korean',
    cats: ['science', 'korean'],
    n: 16,
    focus: 'science 8개(우리 몸: 심장·폐·뼈·혈액·감각기관, 자연: 식물·물순환·계절·날씨·지구와 달의 분명한 사실)와 korean 8개(순우리말/한자어, 단어의 뜻, 표준 맞춤법). 말장난·넌센스 금지. 심장=펌프처럼 너무 똑같은 문항을 반복하지 마세요.',
  },
];

function bulkPrompt(level, batch, avoid) {
  const catLine = batch.cats.length === 1 && batch.cats[0] === 'bible'
    ? `카테고리는 모두 bible.`
    : `카테고리: ${batch.cats.map((c) => `${c}(${CAT_LABEL[c]})`).join(', ')} 를 골고루(가능하면 각 절반).`;
  return `교회학교 OX 퀴즈 문제를 ${batch.n}개 만들어 주세요.
대상: ${LEVELS[level]}.
이번 배치 초점: ${batch.focus}
${catLine}
${STYLE_GUIDE}
${RULES}
- 아래 기존/삭제된/이미 만든 문제와 같은 사실을 묻지 말 것:
${avoid.map((t) => '- ' + t).join('\n')}`;
}

function qaPrompt(items) {
  return `당신은 교회학교 OX 퀴즈의 팩트체커입니다. 개역개정 성경을 기준으로 아래 문제들을 검수하세요.
각 항목에 대해 verdict를 주세요:
- ok: 사실이 정확하고, 정답 O/X가 문장과 일치하며, 애매하지 않고, 성경 구절(해당 시)이 맞음.
- fix: 고치면 쓸 수 있음(오타, 구절 번호 약간 틀림, 문장이 약간 애매). 고친 text/answer/explanation/ref를 반드시 채우세요.
- drop: 사실이 틀렸거나, 해석에 따라 답이 달라지거나, 농담/상식잡학/이중부정/본문에 없는 전설이거나, 고치기 어려움.
주의: 에덴의 금지된 열매를 '사과'라고 한 것, 동방박사를 세 명이라고 한 것, 요나가 '고래'에게 삼켜졌다고 한 것은 drop.
영어 단어가 섞였으면 한국어로 fix.
입력:
${items.map((q, i) => `[${i}] level=${q.level} cat=${q.category} ans=${q.answer} ref=${q.ref || ''}
Q: ${q.text}
E: ${q.explanation}`).join('\n\n')}`;
}

function acceptRaw(raw, level, week, dest, rejected) {
  const q = {
    id: '',
    level,
    category: raw.category,
    text: String(raw.text || '').trim(),
    answer: String(raw.answer || '').trim().toUpperCase(),
    explanation: String(raw.explanation || '').trim(),
    ref: String(raw.ref || '').trim(),
    week,
  };
  const errs = validate(q);
  if (errs.length) { rejected.push({ ...q, errs }); return false; }
  seen.add(norm(q.text));
  assignId(q, dest, week);
  dest.push(q);
  return true;
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

async function runWeekly() {
  const out = [];
  const rejected = [];
  for (const [li, level] of LEVEL_KEYS.entries()) {
    if (li > 0) await sleep(DELAY_MS);
    const avoid = [...bank.filter((q) => q.level === level).map((q) => q.text), ...deleted].slice(0, 120);
    const body = {
      contents: [{ role: 'user', parts: [{ text: weeklyPrompt(level, avoid) }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.7 },
    };
    let data, used;
    try {
      ({ data, model: used } = await generateWithFallback(body));
    } catch (e) {
      console.error(`[gen] ${level}: failed (${e.message}), skipping`);
      continue;
    }
    let arr;
    try { arr = parseArray(data); } catch { console.error(`[gen] ${level}: invalid JSON`); continue; }
    let n = 0;
    for (const raw of arr) if (acceptRaw(raw, level, WEEK, out, rejected)) n++;
    console.log(`[gen] ${level}: ${n} accepted (model ${used})`);
  }
  const file = path.join(ROOT, 'review', `gemini_초안_${WEEK}.json`);
  let prev = [];
  if (fs.existsSync(file)) { try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* start fresh */ } }
  saveJson(file, [...prev, ...out]);
  if (rejected.length) saveJson(file.replace(/\.json$/, '_rejected.json'), rejected);
  const c = {};
  for (const q of out) c[`${q.level}/${q.category}`] = (c[`${q.level}/${q.category}`] || 0) + 1;
  console.log(`[gen] wrote ${out.length} (rejected ${rejected.length}) -> ${path.relative(ROOT, file)}`, c);
  if (!out.length) process.exit(1);
}

function loadSeedGemini(extraFiles = []) {
  const seeds = [];
  const files = [path.join(ROOT, 'review', `gemini_초안_${WEEK}.json`), ...extraFiles];
  for (const p of files) {
  if (fs.existsSync(p)) {
    try {
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(arr)) {
        for (const q of arr) {
          if (!q?.text || seen.has(norm(q.text))) continue;
          seen.add(norm(q.text));
          seeds.push({
            id: q.id,
            level: q.level,
            category: q.category,
            text: String(q.text).trim(),
            answer: String(q.answer).trim().toUpperCase(),
            explanation: String(q.explanation || '').trim(),
            ref: String(q.ref || '').trim(),
            week: q.week || WEEK,
            seed: true,
          });
        }
      }
    } catch { /* ignore */ }
  }
  }
  return seeds;
}

function summarize(list) {
  const by = {};
  const ox = { O: 0, X: 0 };
  for (const q of list) {
    by[`${q.level}/${q.category}`] = (by[`${q.level}/${q.category}`] || 0) + 1;
    if (ox[q.answer] !== undefined) ox[q.answer]++;
  }
  return { total: list.length, ox, by };
}

async function runQa(list) {
  const stats = { ok: 0, fix: 0, drop: 0, failed: 0 };
  const kept = [];
  const dropped = [];
  const chunkSize = 12;
  for (let i = 0; i < list.length; i += chunkSize) {
    if (i > 0) await sleep(DELAY_MS);
    const chunk = list.slice(i, i + chunkSize);
    const body = {
      contents: [{ role: 'user', parts: [{ text: qaPrompt(chunk) }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: QA_SCHEMA, temperature: 0.15 },
    };
    let arr;
    try {
      const { data, model } = await generateWithFallback(body);
      arr = parseArray(data);
      console.log(`[qa] ${i + 1}-${i + chunk.length}/${list.length} model ${model}`);
    } catch (e) {
      console.warn(`[qa] chunk ${i} failed (${e.message}); keeping items for manual review`);
      stats.failed += chunk.length;
      kept.push(...chunk.map((q) => ({ ...q, qa: 'unverified' })));
      continue;
    }
    const byIndex = new Map(arr.map((r) => [Number(r.index), r]));
    for (let j = 0; j < chunk.length; j++) {
      const q = chunk[j];
      const r = byIndex.get(j);
      if (!r || r.verdict === 'ok') {
        stats.ok++;
        kept.push({ ...q, qa: 'ok', qaReason: r?.reason || '' });
        continue;
      }
      if (r.verdict === 'fix' && (r.text || q.text) && ['O', 'X'].includes(String(r.answer || q.answer).toUpperCase())) {
        const fixed = {
          ...q,
          text: String(r.text || q.text).trim(),
          answer: String(r.answer || q.answer).trim().toUpperCase(),
          explanation: String(r.explanation || q.explanation).trim(),
          ref: r.ref != null ? String(r.ref).trim() : q.ref,
          qa: 'fix',
          qaReason: r.reason || '',
        };
        if (fixed.category === 'bible' && !fixed.ref) {
          stats.drop++;
          dropped.push({ ...q, qa: 'drop', qaReason: 'fix missing bible ref: ' + (r.reason || '') });
          continue;
        }
        if (seen.has(norm(fixed.text)) && norm(fixed.text) !== norm(q.text)) {
          stats.drop++;
          dropped.push({ ...fixed, qa: 'drop', qaReason: 'fix collided with duplicate' });
          continue;
        }
        seen.add(norm(fixed.text));
        stats.fix++;
        kept.push(fixed);
        continue;
      }
      stats.drop++;
      dropped.push({ ...q, qa: 'drop', qaReason: r.reason || 'drop' });
    }
  }
  return { kept, dropped, stats };
}

function selectBalanced(pool, perLevel) {
  const order = { bible: 0, church: 1, current: 2, science: 3, korean: 4 };
  const picked = [];
  const used = new Set();
  const targetsOther = Math.round(perLevel * 0.32);
  const targetsBible = perLevel - targetsOther;

  for (const level of LEVEL_KEYS) {
    const cand = pool.filter((q) => q.level === level && !used.has(norm(q.text)));
    cand.sort((a, b) => {
      const qa = (a.qa === 'ok' ? 0 : a.qa === 'fix' ? 1 : 2) - (b.qa === 'ok' ? 0 : b.qa === 'fix' ? 1 : 2);
      if (qa) return qa;
      return (order[a.category] ?? 9) - (order[b.category] ?? 9);
    });
    const bible = cand.filter((q) => q.category === 'bible');
    const other = cand.filter((q) => q.category !== 'bible');
    const take = [];
    const ox = { O: 0, X: 0 };
    const takeOne = (q) => {
      if (!q || take.length >= perLevel) return false;
      if (used.has(norm(q.text))) return false;
      used.add(norm(q.text));
      ox[q.answer] = (ox[q.answer] || 0) + 1;
      take.push(q);
      return true;
    };
    for (const q of bible) {
      if (take.filter((x) => x.category === 'bible').length >= targetsBible) break;
      takeOne(q);
    }
    const byCat = {};
    for (const q of other) {
      byCat[q.category] = byCat[q.category] || [];
      byCat[q.category].push(q);
    }
    const catKeys = Object.keys(byCat);
    let guard = 0;
    while (take.length < perLevel && guard < 500) {
      guard++;
      let progressed = false;
      for (const c of catKeys) {
        if (take.length >= perLevel) break;
        const needOx = ox.O <= ox.X ? 'O' : 'X';
        const prefer = byCat[c].find((q) => !used.has(norm(q.text)) && q.answer === needOx) || byCat[c].find((q) => !used.has(norm(q.text)));
        if (prefer) { takeOne(prefer); progressed = true; }
      }
      if (!progressed) break;
    }
    for (const q of cand) {
      if (take.length >= perLevel) break;
      const needOx = ox.O <= ox.X ? 'O' : 'X';
      if (q.answer === needOx) takeOne(q);
    }
    for (const q of cand) {
      if (take.length >= perLevel) break;
      takeOne(q);
    }
    picked.push(...take);
  }
  picked.sort((a, b) => LEVEL_KEYS.indexOf(a.level) - LEVEL_KEYS.indexOf(b.level) || (order[a.category] ?? 9) - (order[b.category] ?? 9) || a.text.localeCompare(b.text, 'ko'));
  picked.forEach((q, i) => { q.번호 = i + 1; });
  return picked;
}

async function fillShortages(pool, perLevel) {
  const extra = [];
  const rejected = [];
  for (const level of LEVEL_KEYS) {
    const have = pool.filter((q) => q.level === level).length;
    if (have >= perLevel + 8) continue;
    const need = perLevel + 12 - have;
    const n = Math.min(18, Math.max(8, need));
    console.log(`[fill] ${level}: have ${have}, requesting ${n} more`);
    await sleep(DELAY_MS);
    const avoid = [...pool.map((q) => q.text), ...deleted, ...bank.map((q) => q.text)].slice(-100);
    const prompt = `교회학교 OX 퀴즈 문제를 ${n}개 더 만들어 주세요. 대상: ${LEVELS[level]}.
구성: 성경(bible) 약 70%, 나머지 church/current/science/korean 골고루.
${STYLE_GUIDE}
${RULES}
이미 충분한 문항이 있어 새로운 인물·구절·사실만 다루세요.
기존 문제:
${avoid.map((t) => '- ' + t).join('\n')}`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.75 },
    };
    try {
      const { data, model } = await generateWithFallback(body);
      const arr = parseArray(data);
      let nOk = 0;
      for (const raw of arr) if (acceptRaw(raw, level, WEEK, extra, rejected)) nOk++;
      console.log(`[fill] ${level}: +${nOk} (model ${model})`);
    } catch (e) {
      console.warn(`[fill] ${level} failed: ${e.message}`);
    }
  }
  return extra;
}

async function runBulk() {
  const outFile = args.out
    ? path.resolve(ROOT, args.out)
    : path.join(ROOT, 'review', `ox_quiz_${TARGET}_${new Date().toISOString().slice(0, 10)}.json`);
  const metaFile = outFile.replace(/\.json$/, '_qa_meta.json');
  const rejected = [];
  const out = loadSeedGemini([outFile]);
  console.log(`[bulk] seeded ${out.length} existing Gemini drafts`);

  let first = true;
  for (const level of LEVEL_KEYS) {
    for (const batch of BULK_BATCHES) {
      if (!first) await sleep(DELAY_MS);
      first = false;
      const avoid = [
        ...out.filter((q) => q.level === level).map((q) => q.text),
        ...deleted,
        ...bank.filter((q) => q.level === level).map((q) => q.text),
      ].slice(0, 140);
      const body = {
        contents: [{ role: 'user', parts: [{ text: bulkPrompt(level, batch, avoid) }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.7 },
      };
      try {
        const { data, model } = await generateWithFallback(body);
        const arr = parseArray(data);
        let n = 0;
        for (const raw of arr) {
          if (batch.cats.length && !batch.cats.includes(raw.category)) {
            if (batch.cats[0] === 'bible') raw.category = 'bible';
            else if (!CATS.includes(raw.category)) { rejected.push({ ...raw, level, errs: ['category'] }); continue; }
          }
          if (acceptRaw(raw, level, WEEK, out, rejected)) n++;
        }
        console.log(`[bulk] ${level}/${batch.id}: +${n}/${arr.length} total=${out.length} (model ${model})`);
      } catch (e) {
        console.warn(`[bulk] ${level}/${batch.id} failed: ${e.message}`);
      }
      saveJson(outFile, out);
    }
  }

  const extra = await fillShortages(out, Math.ceil(TARGET / LEVEL_KEYS.length));
  out.push(...extra);
  saveJson(outFile, out);
  if (rejected.length) saveJson(outFile.replace(/\.json$/, '_rejected.json'), rejected);
  console.log(`[bulk] raw ${out.length}`, summarize(out));

  let kept = out;
  let dropped = [];
  let qaStats = { skipped: true };
  if (DO_QA && out.length) {
    const result = await runQa(out);
    kept = result.kept;
    dropped = result.dropped;
    qaStats = result.stats;
    saveJson(outFile.replace(/\.json$/, '_postqa.json'), kept);
    saveJson(outFile.replace(/\.json$/, '_dropped.json'), dropped);
    console.log(`[qa] kept ${kept.length} dropped ${dropped.length}`, qaStats);
    const stillShort = LEVEL_KEYS.some((lv) => kept.filter((q) => q.level === lv).length < Math.ceil(TARGET / LEVEL_KEYS.length));
    if (stillShort) {
      const more = await fillShortages(kept, Math.ceil(TARGET / LEVEL_KEYS.length));
      if (more.length) {
        const moreQa = await runQa(more);
        kept.push(...moreQa.kept);
        dropped.push(...moreQa.dropped);
        qaStats.fill = moreQa.stats;
      }
    }
  }

  const perLevel = Math.round(TARGET / LEVEL_KEYS.length) || 75;
  const finalList = selectBalanced(kept, perLevel);
  saveJson(outFile, finalList);
  saveJson(metaFile, { qaStats, dropped: dropped.length, raw: out.length, kept: kept.length, final: finalList.length, summarize: summarize(finalList) });
  console.log(`[bulk] final ${finalList.length} -> ${path.relative(ROOT, outFile)}`, summarize(finalList));
  if (finalList.length < TARGET * 0.85) console.warn(`[bulk] short of target ${TARGET}`);
}

const VERIFY_ONLY = args.verify && args.verify !== true ? String(args.verify) : (args.verify ? (args.out || '') : '');
if (VERIFY_ONLY) {
  const file = path.resolve(ROOT, VERIFY_ONLY);
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { kept, dropped, stats } = await runQa(list);
  saveJson(file.replace(/\.json$/, '_postqa.json'), kept);
  saveJson(file.replace(/\.json$/, '_dropped.json'), dropped);
  console.log(`[verify] kept ${kept.length} dropped ${dropped.length}`, stats);
} else if (TARGET > 0) {
  await runBulk();
} else {
  await runWeekly();
}
