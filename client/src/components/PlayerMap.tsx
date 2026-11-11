import { AvatarIcon } from './AvatarIcon';
import type { PlayerPosition, PlayerSnapshot, Rect, Zones } from '../protocol';

// Fallbacks mirror MAP_BOUNDS / ZONES in server/src/state.js; the server also
// sends them on every room snapshot.
const DEFAULT_BOUNDS: Rect = { xmin: -8, xmax: 8, zmin: -1, zmax: 9 };
const DEFAULT_ZONES: Zones = {
  O: { xmin: -7, xmax: -1.5, zmin: 1, zmax: 6.5 },
  X: { xmin: 1.5, xmax: 7, zmin: 1, zmax: 6.5 },
};

interface Props {
  bounds?: Rect;
  zones?: Zones;
  players: PlayerSnapshot[];
  positions: Record<string, PlayerPosition>;
  meId: string;
  /** Tap handler for the O / X zones. Omit to make the zones non-interactive. */
  onPickZone?: (choice: 'O' | 'X') => void;
  /** Highlights the correct zone during reveal. */
  correctAnswer?: 'O' | 'X' | null;
  className?: string;
}

/** Top-down 2D view of the quiz floor: x runs left to right, z runs top to bottom
 *  (joystick "down" = +z), so it matches what the joystick does. */
export function PlayerMap({ bounds = DEFAULT_BOUNDS, zones = DEFAULT_ZONES, players, positions, meId, onPickZone, correctAnswer, className }: Props) {
  const w = bounds.xmax - bounds.xmin;
  const h = bounds.zmax - bounds.zmin;
  const px = (x: number) => `${(Math.max(0, Math.min(1, (x - bounds.xmin) / w)) * 100).toFixed(2)}%`;
  const pz = (z: number) => `${(Math.max(0, Math.min(1, (z - bounds.zmin) / h)) * 100).toFixed(2)}%`;

  // Draw this player last so they stay on top of a crowd.
  const ordered = [...players].sort((a, b) => Number(a.id === meId) - Number(b.id === meId));

  return (
    <div className={`player-map ${className ?? ''}`} aria-label="퀴즈 지도">
      {(['O', 'X'] as const).map((key) => {
        const z = zones[key];
        const cls = [
          'player-map-zone',
          key.toLowerCase(),
          correctAnswer ? (correctAnswer === key ? 'correct' : 'wrong') : '',
        ].join(' ');
        return (
          <button
            key={key}
            type="button"
            className={cls}
            disabled={!onPickZone}
            aria-label={`${key} 구역으로 가기`}
            onClick={() => onPickZone?.(key)}
            style={{
              left: px(z.xmin),
              top: pz(z.zmin),
              width: `${((z.xmax - z.xmin) / w) * 100}%`,
              height: `${((z.zmax - z.zmin) / h) * 100}%`,
            }}
          >
            {key}
          </button>
        );
      })}

      {ordered.map((p) => {
        const pos = positions[p.id];
        if (!pos) return null;
        const mine = p.id === meId;
        return (
          <div
            key={p.id}
            className={`player-map-avatar ${mine ? 'me' : ''}`}
            style={{ left: px(pos.x), top: pz(pos.z) }}
          >
            <div className="player-map-sprite" style={{ transform: `translateY(${-Math.round(pos.y * 12)}px)` }}>
              <AvatarIcon avatarId={p.avatar} cosmetics={p.cosmetics} size={mine ? 30 : 20} />
            </div>
            <span className="player-map-name">{mine ? `${p.nickname} (나)` : p.nickname}</span>
          </div>
        );
      })}
    </div>
  );
}
