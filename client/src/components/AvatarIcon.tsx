import { BODY_COLORS, decodeAvatar, SKIN_TONES, type HatType } from '../avatars';

import type { Cosmetics } from '../protocol';

interface Props {
  avatarId: string;
  size?: number;
  cosmetics?: Cosmetics;
}

// 상점 아이템의 픽셀 아이콘 버전 (3D 모양과 같은 디자인을 사각형으로 단순화)
function ShopHatIcon({ id }: { id: string }) {
  switch (id) {
    case 'hat-sprout':
      return (
        <g>
          <rect x="15" y="4" width="10" height="4" fill="#a9643a" />
          <rect x="19" y="0" width="2" height="4" fill="#3f9b3a" />
          <rect x="14" y="0" width="5" height="2" fill="#5fc94f" />
          <rect x="21" y="1" width="5" height="2" fill="#5fc94f" />
        </g>
      );
    case 'hat-melon':
      return (
        <g>
          <rect x="8" y="2" width="24" height="7" fill="#4fb548" />
          <rect x="12" y="2" width="2" height="7" fill="#2c7a2f" />
          <rect x="19" y="2" width="2" height="7" fill="#2c7a2f" />
          <rect x="26" y="2" width="2" height="7" fill="#2c7a2f" />
          <rect x="8" y="9" width="24" height="2" fill="#e2483d" />
        </g>
      );
    case 'hat-propeller':
      return (
        <g>
          <rect x="9" y="5" width="22" height="5" fill="#3182f6" />
          <rect x="19" y="2" width="2" height="3" fill="#f5c518" />
          <rect x="11" y="0" width="18" height="2" fill="#e2483d" />
        </g>
      );
    case 'hat-ruby':
      return (
        <g>
          <rect x="9" y="5" width="22" height="5" fill="#f5c518" />
          <rect x="9" y="2" width="4" height="3" fill="#f5c518" />
          <rect x="18" y="1" width="4" height="4" fill="#f5c518" />
          <rect x="27" y="2" width="4" height="3" fill="#f5c518" />
          <rect x="18" y="5" width="4" height="4" fill="#e0245e" />
        </g>
      );
    default:
      return null;
  }
}

function OutfitIcon({ id }: { id: string }) {
  switch (id) {
    case 'outfit-checker':
      return (
        <g>
          <rect x="8" y="20" width="24" height="12" fill="#f4f1e6" />
          {[0, 1, 2, 3].map((c) => [0, 1].map((r) => ((r + c) % 2 === 0 ? <rect key={`${c}${r}`} x={8 + c * 6} y={20 + r * 6} width="6" height="6" fill="#2b3a67" /> : null)))}
        </g>
      );
    case 'outfit-rainbow':
      return (
        <g>
          {['#e2483d', '#f08a24', '#f5c518', '#45b35c', '#3182f6'].map((color, i) => (
            <rect key={color} x="8" y={20 + i * 2.4} width="24" height="2.4" fill={color} />
          ))}
        </g>
      );
    case 'outfit-ice':
      return (
        <g>
          <rect x="8" y="20" width="24" height="12" fill="#bfefff" />
          <rect x="16" y="22" width="8" height="6" fill="#7fd6f5" />
          <rect x="8" y="20" width="5" height="3" fill="#ffffff" />
          <rect x="27" y="20" width="5" height="3" fill="#ffffff" />
        </g>
      );
    case 'outfit-gold':
      return (
        <g>
          <rect x="8" y="20" width="24" height="12" fill="#f5c518" />
          <rect x="14" y="21" width="12" height="8" fill="#d99a00" />
          <rect x="18" y="23" width="4" height="4" fill="#fff2a8" />
        </g>
      );
    default:
      return null;
  }
}

function ExtraBackIcon({ id }: { id: string }) {
  if (id === 'extra-cape') return <rect x="5" y="19" width="30" height="16" fill="#e2483d" />;
  if (id === 'extra-wings') {
    return (
      <g>
        <rect x="0" y="18" width="9" height="5" fill="#ffffff" stroke="#9fb3cc" strokeWidth="0.6" />
        <rect x="2" y="23" width="7" height="4" fill="#dfe9f5" stroke="#9fb3cc" strokeWidth="0.6" />
        <rect x="31" y="18" width="9" height="5" fill="#ffffff" stroke="#9fb3cc" strokeWidth="0.6" />
        <rect x="31" y="23" width="7" height="4" fill="#dfe9f5" stroke="#9fb3cc" strokeWidth="0.6" />
      </g>
    );
  }
  return null;
}

function ExtraFrontIcon({ id }: { id: string }) {
  if (id !== 'extra-pet') return null;
  return (
    <g>
      <rect x="32" y="9" width="8" height="8" fill="#18a999" />
      <rect x="35" y="7" width="2" height="2" fill="#f5c518" />
      <rect x="33" y="11" width="2" height="2" fill="#ffffff" />
      <rect x="37" y="11" width="2" height="2" fill="#ffffff" />
    </g>
  );
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

export function AvatarIcon({ avatarId, size = 40, cosmetics }: Props) {
  const { skin, body, hat } = decodeAvatar(avatarId);
  const skinColor = SKIN_TONES[skin];
  const bodyColor = BODY_COLORS[body];
  const hats = ['none', 'cap', 'crown', 'helmet', 'flower', 'visor'] as HatType[];
  const hatType = hats[hat] ?? 'none';

  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" shapeRendering="crispEdges">
      {cosmetics?.extra && <ExtraBackIcon id={cosmetics.extra} />}
      {/* legs */}
      <rect x="10" y="32" width="8" height="6" fill={PANTS_COLOR} />
      <rect x="22" y="32" width="8" height="6" fill={PANTS_COLOR} />
      <rect x="10" y="37" width="8" height="3" fill={SHOE_COLOR} />
      <rect x="22" y="37" width="8" height="3" fill={SHOE_COLOR} />
      {/* body */}
      <rect x="8" y="20" width="24" height="12" fill={bodyColor} />
      {cosmetics?.outfit && <OutfitIcon id={cosmetics.outfit} />}
      {/* head */}
      <rect x="10" y="8" width="20" height="12" fill={skinColor} />
      {/* eyes */}
      <rect x="14" y="13" width="3" height="3" fill="#1c2330" />
      <rect x="23" y="13" width="3" height="3" fill="#1c2330" />
      {/* hat */}
      {cosmetics?.hat ? <ShopHatIcon id={cosmetics.hat} /> : <Hat type={hatType} />}
      {cosmetics?.extra && <ExtraFrontIcon id={cosmetics.extra} />}
    </svg>
  );
}
