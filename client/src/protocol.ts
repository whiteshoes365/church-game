export type RoomStatus = 'lobby' | 'question' | 'reveal' | 'finished';
export type Capacity = 4 | 8 | 'unlimited';
export type MapTheme = 'sanctuary' | 'playground' | 'forest';
export type Level = 'elementary' | 'middle' | 'high' | 'youth';
export type Category = 'bible' | 'nonsense';

export interface PlayerSnapshot {
  id: string;
  nickname: string;
  avatar: string;
  side: 'O' | 'X' | null;
  score: number;
  connected: boolean;
  teamId?: string | null;
  cosmetics?: Cosmetics;
  recorded?: boolean;
}

// 상점에서 사서 착용한 꾸미기 아이템 (슬롯별 아이템 id)
export interface Cosmetics {
  hat?: string;
  outfit?: string;
  extra?: string;
}

export interface ShopItem {
  id: string;
  slot: 'hat' | 'outfit' | 'extra';
  name: string;
  price: number;
  desc: string;
}

export interface ShopState {
  nickname: string;
  avatar?: string | null;
  balance: number;
  owned: string[];
  equipped: Cosmetics;
  weeklyCap: number;
  weekEarned: number;
  weekRemaining: number;
  items: ShopItem[];
}

export interface TeamStanding {
  id: string;
  name: string;
  color: string;
  size: number;
  total: number; // 합계 = 팀원 점수의 합
  average: number; // 평균 = 합계 ÷ 팀원 수
  memberIds?: string[]; // 이 점수를 낸 팀원들
}

export interface TeamState {
  enabled: boolean;
  count: number;
  bonus: number;
  teams: TeamStanding[];
}

export type LedgerKind = 'game' | 'team' | 'streak' | 'manual' | 'shop';

export interface AwardPart {
  delta: number;
  reason: string;
  kind: LedgerKind;
  requested?: number;
  capped?: boolean;
}

export interface GameAward {
  id: string;
  nickname: string;
  delta: number;
  requested?: number;
  capped?: boolean; // 주간 상한 때문에 깎였는지
  weekRemaining?: number;
  weeklyCap?: number;
  parts: AwardPart[];
}

export interface FinalResult {
  totalQuestions: number;
  mvpIds: string[];
  team: {
    teams: TeamStanding[];
    winnerTeamIds: string[];
    loserTeamIds: string[];
    tie: boolean;
    bonus: number;
  } | null;
  awards: GameAward[];
  recorded: boolean;
}

export interface GroupMember {
  key: string;
  nickname: string;
  avatar: string | null;
  total: number;
  weekTalents: number;
  attendedWeeks: string[];
  attendCount: number;
  presentThisWeek: boolean;
  streak: number;
  badge: { id: string; label: string } | null;
  weekEarned: number;
  weekRemaining: number;
  equipped: Cosmetics;
  ownedCount: number;
  claimed: boolean;
}

export interface LedgerEntry {
  id: string;
  at: number;
  week: string;
  key: string;
  nickname: string;
  delta: number;
  reason: string;
  kind: LedgerKind;
  gameId: string | null;
  requested?: number;
  capped?: boolean; // 주간 상한으로 깎여서 지급됨
  override?: boolean; // 교사 수동 지급이 주간 상한을 넘김 (상한 예외)
  itemId?: string;
}

export interface GameRecord {
  id: string;
  at: number;
  week: string;
  roomTitle: string;
  level: Level;
  totalQuestions: number;
  players: { nickname: string; score: number; teamId: string | null }[];
  mvpNicknames: string[];
  team: { bonus: number; tie: boolean; teams: TeamStanding[]; winnerTeamIds: string[] } | null;
}

export interface GroupData {
  code: string;
  currentWeek: string;
  weeks: { id: string; label: string; presentCount: number }[];
  members: GroupMember[];
  mvp: { nickname: string; avatar: string | null; weekTalents: number }[];
  ledger: LedgerEntry[];
  games: GameRecord[];
  rules: {
    participation: number;
    rank: number[];
    perfect: number;
    perfectMinQuestions: number;
    streakWeeks: number;
    streakBonus: number;
    teamBonusMax: number;
    manualMax: number;
    weeklyCapDefault: number;
    weeklyCapMin: number;
    weeklyCapMax: number;
  };
  settings: { weeklyCap: number };
}

export interface QuestionSnapshot {
  index: number;
  total: number;
  text: string | null;
  category: Category | null;
  deadline: number | null;
}

export interface LastResult {
  questionText: string;
  correctAnswer: 'O' | 'X';
  correctPlayerIds: string[];
  explanation?: string | null;
  category?: Category | null;
}

export interface Rect {
  xmin: number;
  xmax: number;
  zmin: number;
  zmax: number;
}

export interface Zones {
  O: Rect;
  X: Rect;
}

export type MoveState = 'idle' | 'walk' | 'run' | 'crawl' | 'jump';

export interface PlayerPosition {
  id: string;
  x: number;
  z: number;
  y: number;
  state: MoveState;
}

export interface RoomSnapshot {
  id: string;
  pin?: string; // 호스트에게만 내려오는 방 PIN (학생 입장용)
  hostPassword?: string; // 호스트에게만 내려오는 진행자 비밀번호 (방 PIN 과 별개)
  churchId: string;
  title: string;
  map: MapTheme;
  level: Level;
  capacity: Capacity;
  questionCount?: number;
  status: RoomStatus;
  players: PlayerSnapshot[];
  hasHost: boolean;
  bounds?: Rect;
  zones?: Zones;
  questionDurationMs?: number;
  question: QuestionSnapshot | null;
  lastResult: LastResult | null;
  groupCode?: string | null;
  team?: TeamState;
  finalResult?: FinalResult | null;
}

export interface RoomSummary {
  id: string;
  title: string;
  map: MapTheme;
  level: Level;
  capacity: Capacity;
  playerCount: number;
  status: RoomStatus;
  groupCode?: string | null;
  teamMode?: boolean;
}

export interface ChurchRef {
  id: string;
  name: string;
}
