export type HatType = 'none' | 'cap' | 'crown' | 'helmet' | 'flower' | 'visor';

export interface AvatarConfig {
  skin: number;
  body: number;
  hat: number;
}

// 아바타는 픽셀 블록 캐릭터예요: 피부색 + 옷 색 + 모자 조합.
// 이미지/이모지/상표 텍스처를 쓰지 않고 색상 블록만으로 표현해요.
export const SKIN_TONES: string[] = ['#ffd9b3', '#f0b088', '#c88a5c', '#8d5a3c'];

export const BODY_COLORS: string[] = [
  '#3182f6',
  '#2ecc71',
  '#ff5a5f',
  '#f5b400',
  '#9b59b6',
  '#18a999',
  '#ec5fa3',
  '#e67e22',
];

export const HATS: { id: HatType; label: string }[] = [
  { id: 'none', label: '모자 없음' },
  { id: 'cap', label: '야구모자' },
  { id: 'crown', label: '왕관' },
  { id: 'helmet', label: '헬멧' },
  { id: 'flower', label: '꽃' },
  { id: 'visor', label: '바이저' },
];

const AVATAR_ID_PATTERN = /^s(\d+)b(\d+)h(\d+)$/;

export const DEFAULT_AVATAR_CONFIG: AvatarConfig = { skin: 0, body: 0, hat: 0 };

function clampIndex(value: number, length: number): number {
  if (Number.isNaN(value) || value < 0 || value >= length) return 0;
  return value;
}

// 서버는 avatar를 단순 문자열로만 저장/전달해요 (server/src/state.js 참고).
// 기존 필드를 그대로 쓰면서 선택 정보를 문자열에 인코딩합니다, 예: 's1b3h2'.
export function encodeAvatar(config: AvatarConfig): string {
  return `s${config.skin}b${config.body}h${config.hat}`;
}

export function decodeAvatar(avatarId: string | undefined | null): AvatarConfig {
  const match = avatarId ? AVATAR_ID_PATTERN.exec(avatarId) : null;
  if (!match) return DEFAULT_AVATAR_CONFIG;
  return {
    skin: clampIndex(Number(match[1]), SKIN_TONES.length),
    body: clampIndex(Number(match[2]), BODY_COLORS.length),
    hat: clampIndex(Number(match[3]), HATS.length),
  };
}

export const DEFAULT_AVATAR_ID = encodeAvatar(DEFAULT_AVATAR_CONFIG);
