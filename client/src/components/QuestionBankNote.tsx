// 방 만들기 화면: 고른 난이도의 실제 문제 은행 개수(전체·주제별)와
// "은행보다 많이 고르면 은행만큼만 나온다"는 안내. 숫자는 서버가 집계해 준 값만 쓴다.
import { CATEGORY_LABELS } from '../categories';
import { LEVEL_LABELS } from '../levels';
import type { Category, Level } from '../protocol';

export type BankCounts = { total: number } & Partial<Record<Category, number>>;
export type QuestionBankDetail = Partial<Record<Level, BankCounts>>;

const CATEGORY_ORDER: Category[] = ['bible', 'season', 'nature', 'korean', 'current', 'nonsense'];

function formatBreakdown(bank: BankCounts): string {
  return CATEGORY_ORDER.filter((c) => typeof bank[c] === 'number')
    .map((c) => `${CATEGORY_LABELS[c]} ${bank[c]}`)
    .join(' · ');
}

export function QuestionBankNote({ level, detail, selected }: { level: Level; detail: QuestionBankDetail; selected: number }) {
  const bank = detail[level];
  if (!bank) return <p className="fine-print question-bank-note">문제 은행 개수를 불러오는 중이에요…</p>;
  const actual = Math.min(selected, bank.total);
  const breakdown = formatBreakdown(bank);
  return (
    <div className="question-bank-note question-bank-box" data-testid="question-bank-note">
      <p className="fine-print">
        <b>
          {LEVEL_LABELS[level]} 문제 은행: 전체 {bank.total}문제
        </b>
        {breakdown ? ` (${breakdown})` : ''}
      </p>
      <p className="fine-print">
        {selected > bank.total
          ? `${selected}문제를 골랐지만 은행에 ${bank.total}문제뿐이라 ${bank.total}문제만 나와요.`
          : `이번 방은 ${actual}문제가 나와요. 은행보다 많이 고르면 은행에 있는 만큼만 나와요.`}
      </p>
    </div>
  );
}
