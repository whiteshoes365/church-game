import { useEffect, useRef, useState } from 'react';
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

const ME_SIZE = 30;
const OTHER_SIZE = 20;
const NAME_MAX_W = 72; // must match .player-map-name max-width
const NAME_GAP = 1;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function hits(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

// Width the name tag will take, a little generous so tags never touch.
// Hangul and other wide glyphs are one em in this pixel font; ASCII is narrower.
function nameWidth(text: string, fontPx: number, chromePx: number): number {
  let em = 0;
  for (const ch of text) em += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.62;
  return Math.min(NAME_MAX_W, Math.ceil(em * fontPx) + chromePx + 2);
}

interface NamePlacement {
  dx: number; // tag centre, px from the avatar centre
  dy: number; // tag top, px from the avatar centre
  hidden: boolean;
}

/** Decides where each name tag goes so tags cover neither each other nor another
 *  player's avatar: below the avatar if free, otherwise above, then further
 *  out. In a crowd too dense for that, the tag is hidden rather than stacked on
 *  top of another one (your own tag is placed first and always shows). */
function placeNames(
  items: { id: string; cx: number; cy: number; size: number; label: string; mine: boolean }[],
  mapW: number,
  mapH: number,
): Map<string, NamePlacement> {
  const out = new Map<string, NamePlacement>();
  // Only the middle of a neighbour's avatar counts as "covered": the drawn
  // character is smaller than its icon box, and tags may brush its edge.
  const sprites = items.map((it) => {
    const r = it.size * 0.3;
    return { id: it.id, box: { x0: it.cx - r, y0: it.cy - r, x1: it.cx + r, y1: it.cy + r } };
  });
  const placed: Box[] = [];
  const order = [...items].sort((a, b) => Number(b.mine) - Number(a.mine) || a.cy - b.cy || a.cx - b.cx);
  for (const it of order) {
    const font = it.mine ? 11 : 9;
    const w = nameWidth(it.label, font, it.mine ? 12 : 10);
    const h = font + (it.mine ? 8 : 6);
    const half = it.size / 2;
    const below = half + NAME_GAP;
    const above = -(half + NAME_GAP + h);
    const side = half + NAME_GAP + w / 2;
    const candidates: [number, number][] = [
      [0, below],
      [0, above],
      [side, -h / 2],
      [-side, -h / 2],
      [0, below + h + NAME_GAP],
      [0, above - h - NAME_GAP],
      [side, below - h / 2],
      [-side, below - h / 2],
      [side, above + h / 2],
      [-side, above + h / 2],
    ];
    let chosen: NamePlacement | null = null;
    // First try to keep clear of other avatars too; if the crowd is too tight
    // for that, only insist that tags never cover each other.
    for (const avoidSprites of [true, false]) {
      for (const [dx, dy] of candidates) {
        const box = { x0: it.cx + dx - w / 2, y0: it.cy + dy, x1: it.cx + dx + w / 2, y1: it.cy + dy + h };
        if (box.x0 < 0 || box.y0 < 0 || box.x1 > mapW || box.y1 > mapH) continue;
        if (placed.some((p) => hits(p, box))) continue;
        if (avoidSprites && sprites.some((sp) => sp.id !== it.id && hits(sp.box, box))) continue;
        placed.push(box);
        chosen = { dx, dy, hidden: false };
        break;
      }
      if (chosen) break;
    }
    if (!chosen) {
      // Nowhere free. Keep your own tag (clamped inside the map); hide others.
      const dx = Math.max(w / 2 - it.cx, Math.min(mapW - w / 2 - it.cx, 0));
      const dy = it.cy + below + h > mapH ? above : below;
      chosen = { dx, dy, hidden: !it.mine };
      if (it.mine) placed.push({ x0: it.cx + dx - w / 2, y0: it.cy + dy, x1: it.cx + dx + w / 2, y1: it.cy + dy + h });
    }
    out.set(it.id, chosen);
  }
  return out;
}

/** Top-down 2D view of the quiz floor: x runs left to right, z runs top to bottom
 *  (joystick "down" = +z), so it matches what the joystick does. */
export function PlayerMap({ bounds = DEFAULT_BOUNDS, zones = DEFAULT_ZONES, players, positions, meId, onPickZone, correctAnswer, className }: Props) {
  const w = bounds.xmax - bounds.xmin;
  const h = bounds.zmax - bounds.zmin;
  const fx = (x: number) => Math.max(0, Math.min(1, (x - bounds.xmin) / w));
  const fz = (z: number) => Math.max(0, Math.min(1, (z - bounds.zmin) / h));
  const px = (x: number) => `${(fx(x) * 100).toFixed(2)}%`;
  const pz = (z: number) => `${(fz(z) * 100).toFixed(2)}%`;

  // Name tags are laid out in pixels, so track the map's real size.
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapSize, setMapSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    const measure = () => setMapSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Draw this player last so they stay on top of a crowd.
  const ordered = [...players].sort((a, b) => Number(a.id === meId) - Number(b.id === meId));
  const labelOf = (p: PlayerSnapshot) => (p.id === meId ? `${p.nickname} (나)` : p.nickname);
  const names = placeNames(
    ordered
      .filter((p) => positions[p.id])
      .map((p) => ({
        id: p.id,
        cx: fx(positions[p.id].x) * mapSize.w,
        cy: fz(positions[p.id].z) * mapSize.h,
        size: p.id === meId ? ME_SIZE : OTHER_SIZE,
        label: labelOf(p),
        mine: p.id === meId,
      })),
    mapSize.w,
    mapSize.h,
  );

  return (
    <div ref={mapRef} className={`player-map ${className ?? ''}`} aria-label="퀴즈 지도">
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
        const name = names.get(p.id);
        return (
          <div
            key={p.id}
            className={`player-map-avatar ${mine ? 'me' : ''}`}
            style={{ left: px(pos.x), top: pz(pos.z) }}
          >
            <div className="player-map-sprite" style={{ transform: `translate(-50%, -50%) translateY(${-Math.round(pos.y * 12)}px)` }}>
              <AvatarIcon avatarId={p.avatar} cosmetics={p.cosmetics} size={mine ? ME_SIZE : OTHER_SIZE} />
            </div>
            {name && !name.hidden && mapSize.w > 0 && (
              <span className="player-map-name" style={{ transform: `translate(-50%, 0) translate(${name.dx.toFixed(1)}px, ${name.dy.toFixed(1)}px)` }}>
                {labelOf(p)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
