import { getAvatar } from '../avatars';

interface Props {
  avatarId: string;
  size?: number;
}

export function AvatarIcon({ avatarId, size = 40 }: Props) {
  const avatar = getAvatar(avatarId);
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 40 40" aria-hidden="true">
      {avatar.shape === 'circle' && <circle cx="20" cy="20" r="18" fill={avatar.color} />}
      {avatar.shape === 'square' && <rect x="3" y="3" width="34" height="34" rx="8" fill={avatar.color} />}
      {avatar.shape === 'triangle' && <polygon points="20,3 37,35 3,35" fill={avatar.color} />}
      {avatar.shape === 'star' && (
        <polygon
          points="20,2 25,15 39,15 28,24 32,38 20,29 8,38 12,24 1,15 15,15"
          fill={avatar.color}
        />
      )}
    </svg>
  );
}
