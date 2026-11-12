export type RoomStatus = 'lobby' | 'question' | 'reveal' | 'finished';
export type Capacity = 4 | 8 | 'unlimited';
export type MapTheme = 'sanctuary' | 'playground' | 'forest';
export type Level = 'elementary' | 'middle' | 'high' | 'youth';
export type Category = 'bible' | 'season' | 'nature' | 'korean' | 'current' | 'nonsense';

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
  paused?: boolean; // 선생님이 문제 시간을 멈춤
  remainingMs?: number | null; // 멈춘 동안 남아 있는 시간
  answer?: 'O' | 'X'; // 리모컨에만 내려오는 정답 (공개 전)
  explanation?: string | null; // 리모컨에만
}

/** 서버가 기억하는 배경 음악 선택 (소리는 송출 화면 또는 진행자 PC 에서만 난다). */
export interface RoomMusic {
  track: string;
  enabled: boolean;
  volume: number;
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
  gait?: Gait; // 지금 켜져 있는 기술 (걷기일 때는 없음)
}

// 뛰기·기어가기: 잠깐(durationMs) 켜지고, 끝난 뒤 cooldownTotalMs 동안 다시 쓸 수 없다.
export type Gait = 'run' | 'crawl';

/** 서버가 학생에게 보내는 'gait' 메시지. 시각이 아니라 "남은 ms" 로 온다. */
export interface GaitStatus {
  roomId: string;
  ok?: boolean;
  reason?: 'busy' | 'cooldown' | 'unknown' | null;
  mode: Gait | null;
  activeMs: number;
  cooldownMs: Record<Gait, number>; // 기술이 끝난 뒤(꺼져 있으면 지금)부터 남은 쿨타임
  durationMs: number;
  cooldownTotalMs: number;
}

export interface RoomSnapshot {
  id: string;
  pin?: string; // 호스트에게만 내려오는 방 PIN (학생 입장용)
  hostPassword?: string; // 호스트에게만 내려오는 진행자 비밀번호 (방 PIN 과 별개)
  controlKey?: string; // 진행자·리모컨에게만: 재접속 키
  joinCode?: string; // 진행자·리모컨·송출 화면에만: 짧은 입장 코드
  joinPath?: string; // QR 에 넣는 입장 경로 (방 PIN 포함) — 전체 주소는 joinLink.ts
  joinPathNoPin?: string; // 글자로 보여 주는 입장 경로 (방 PIN 없음)
  music?: RoomMusic;
  showQr?: boolean; // 송출 화면에 입장 QR 을 보여 줄지
  displayCount?: number; // 붙어 있는 송출 화면 수
  remoteCount?: number; // 붙어 있는 리모컨 수
  kickedCount?: number; // 내보낸 기기 수
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
