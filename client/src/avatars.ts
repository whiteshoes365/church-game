export type AvatarShape = 'circle' | 'square' | 'triangle' | 'star';

export interface AvatarOption {
  id: string;
  shape: AvatarShape;
  color: string;
}

// 아바타 = 모양 + 색상 조합. 이미지/이모지를 쓰지 않아 깔끔한 톤을 유지해요.
export const AVATAR_OPTIONS: AvatarOption[] = [
  { id: 'circle-blue', shape: 'circle', color: '#3182F6' },
  { id: 'circle-orange', shape: 'circle', color: '#FF9800' },
  { id: 'square-green', shape: 'square', color: '#2ECC71' },
  { id: 'square-purple', shape: 'square', color: '#9B59B6' },
  { id: 'triangle-red', shape: 'triangle', color: '#FF5A5F' },
  { id: 'triangle-teal', shape: 'triangle', color: '#18A999' },
  { id: 'star-yellow', shape: 'star', color: '#F5B400' },
  { id: 'star-pink', shape: 'star', color: '#EC5FA3' },
];

export function getAvatar(id: string): AvatarOption {
  return AVATAR_OPTIONS.find((a) => a.id === id) ?? AVATAR_OPTIONS[0];
}
