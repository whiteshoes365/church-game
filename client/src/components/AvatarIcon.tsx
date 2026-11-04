import { BODY_COLORS, decodeAvatar, SKIN_TONES, type HatType } from '../avatars';

interface Props {
  avatarId: string;
  size?: number;
}

const PANTS_COLOR = '#2f3b52';
const SHOE_COLOR = '#1c2330';

function Hat({ type }: { type: HatType }) {
  switch (type) {
    case 'cap':
      return (
        <g>
          <rect x="9" y="5" width="22" height="5" fill="#d64545" shapeRendering="crispEdges" />
          <rect x="8" y="9" width="12" height="3" fill="#b53a3a" shapeRendering="crispEdges" />
        </g>
      );
    case 'crown':
      return (
        <polygon
          points="9,9 9,3 14,8 20,2 26,8 31,3 31,9"
          fill="#f5c518"
          stroke="#c99a00"
          strokeWidth="1"
          shapeRendering="crispEdges"
        />
      );
    case 'helmet':
      return (
        <g>
          <rect x="8" y="4" width="24" height="11" fill="#9aa5b1" shapeRendering="crispEdges" />
          <rect x="11" y="11" width="18" height="3" fill="#434a52" shapeRendering="crispEdges" />
        </g>
      );
    case 'flower':
      return (
        <g>
          <circle cx="14" cy="6" r="3" fill="#ec5fa3" />
          <circle cx="20" cy="4" r="3" fill="#ff8fc6" />
          <circle cx="26" cy="6" r="3" fill="#ec5fa3" />
          <circle cx="20" cy="7" r="2.5" fill="#f5b400" />
        </g>
      );
    case 'visor':
      return (
        <g>
          <rect x="9" y="5" width="22" height="4" fill="#4b5563" shapeRendering="crispEdges" />
          <rect x="10" y="13" width="20" height="4" fill="#111827" shapeRendering="crispEdges" />
        </g>
      );
    default:
      return null;
  }
}

export function AvatarIcon({ avatarId, size = 40 }: Props) {
  const { skin, body, hat } = decodeAvatar(avatarId);
  const skinColor = SKIN_TONES[skin];
  const bodyColor = BODY_COLORS[body];
  const hats = ['none', 'cap', 'crown', 'helmet', 'flower', 'visor'] as HatType[];
  const hatType = hats[hat] ?? 'none';

  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" shapeRendering="crispEdges">
      {/* legs */}
      <rect x="10" y="32" width="8" height="6" fill={PANTS_COLOR} />
      <rect x="22" y="32" width="8" height="6" fill={PANTS_COLOR} />
      <rect x="10" y="37" width="8" height="3" fill={SHOE_COLOR} />
      <rect x="22" y="37" width="8" height="3" fill={SHOE_COLOR} />
      {/* body */}
      <rect x="8" y="20" width="24" height="12" fill={bodyColor} />
      {/* head */}
      <rect x="10" y="8" width="20" height="12" fill={skinColor} />
      {/* eyes */}
      <rect x="14" y="13" width="3" height="3" fill="#1c2330" />
      <rect x="23" y="13" width="3" height="3" fill="#1c2330" />
      {/* hat */}
      <Hat type={hatType} />
    </svg>
  );
}
