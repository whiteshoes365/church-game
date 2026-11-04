import type { Level } from './protocol';

export const DEFAULT_LEVEL: Level = 'elementary';

export const LEVEL_OPTIONS: { value: Level; label: string; className: string }[] = [
  { value: 'elementary', label: '초등', className: 'level-elementary' },
  { value: 'middle', label: '중등', className: 'level-middle' },
  { value: 'high', label: '고등', className: 'level-high' },
  { value: 'youth', label: '청년', className: 'level-youth' },
];

export const LEVEL_LABELS: Record<Level, string> = {
  elementary: '초등',
  middle: '중등',
  high: '고등',
  youth: '청년',
};

export const LEVEL_CLASS: Record<Level, string> = {
  elementary: 'level-elementary',
  middle: 'level-middle',
  high: 'level-high',
  youth: 'level-youth',
};
