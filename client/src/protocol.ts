export type RoomStatus = 'lobby' | 'question' | 'reveal' | 'finished';
export type Capacity = 4 | 8 | 'unlimited';
export type MapTheme = 'sanctuary' | 'playground' | 'forest';
export type Level = 'elementary' | 'middle' | 'high' | 'youth';
export type Category = 'bible' | 'general' | 'nonsense';

export interface PlayerSnapshot {
  id: string;
  nickname: string;
  avatar: string;
  side: 'O' | 'X' | null;
  score: number;
  connected: boolean;
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
}

export interface RoomSummary {
  id: string;
  title: string;
  map: MapTheme;
  level: Level;
  capacity: Capacity;
  playerCount: number;
  status: RoomStatus;
}

export interface ChurchRef {
  id: string;
  name: string;
}
