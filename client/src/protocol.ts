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
}

export interface TeamStanding {
  id: string;
  name: string;
  color: string;
  size: number;
  total: number;
  average: number;
}

export interface TeamState {
  enabled: boolean;
  count: number;
  bonus: number;
  teams: TeamStanding[];
}

export interface AwardPart {
  delta: number;
  reason: string;
  kind: 'game' | 'team' | 'streak' | 'manual';
}

export interface GameAward {
  id: string;
  nickname: string;
  delta: number;
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
}

export interface LedgerEntry {
  id: string;
  at: number;
  week: string;
  key: string;
  nickname: string;
  delta: number;
  reason: string;
  kind: 'game' | 'team' | 'streak' | 'manual';
  gameId: string | null;
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
  };
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
  churchId: string;
  title: string;
  map: MapTheme;
  level: Level;
  capacity: Capacity;
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
