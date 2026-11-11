import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { CenterDivider } from './CenterDivider';
import { Terrain } from './Terrain';
import { LetterStructure, type RevealState } from './LetterStructure';
import { Clouds } from './Clouds';
import { NAME_TAG_DISTANCE_FACTOR, VoxelCharacter, nameTagHeight } from './VoxelCharacter';
import type { PlayerPosition, PlayerSnapshot, Rect, RoomStatus, Zones } from '../protocol';

// Fallback zones, identical to the server defaults, used only until the
// first roomState carrying the authoritative server-sent zones arrives.
const DEFAULT_ZONES: Zones = {
  O: { xmin: -7, xmax: -1.5, zmin: 1, zmax: 6.5 },
  X: { xmin: 1.5, xmax: 7, zmin: 1, zmax: 6.5 },
};

function zoneCenterX(box: Rect): number {
  return (box.xmin + box.xmax) / 2;
}

// ---- 이름표 겹침 방지 ----
// 이름표는 캐릭터 머리 위에 뜨는데, 같은 구역에 여럿이 서면 옆 사람·앞뒤 줄
// 이름표와 겹친다. 서버가 알려 준 자리(x, z)를 화면 좌표로 옮겨 보고(카메라·글자
// 크기는 아래 상수와 CSS 에서 온다), 겹칠 이웃이 있으면 이름표를 한 단씩 위로
// 올린다(가장 낮은 빈 단을 고른다).
const CAMERA = { x: 0, y: 11.4, z: 16.4, fov: 46 }; // HostCanvas3D 의 카메라와 같아야 한다
const LOOK_AT = { x: 0, y: 0.85, z: 1.6 }; // 앞줄 발이 잘리지 않게 시점을 조금 내리고 뒤로
const CHARACTER_SCALE = 1.5;
const LABEL_TIER = 0.62; // 한 단 높이 (캐릭터 기준 단위)
const LABEL_TIERS = 8;
const LABEL_MARGIN_PX = 5; // 카메라 흔들림·걷는 동안의 오차를 위한 여유

const FOV_TAN = Math.tan((CAMERA.fov * Math.PI) / 360);
const FWD = (() => {
  const dy = LOOK_AT.y - CAMERA.y;
  const dz = LOOK_AT.z - CAMERA.z;
  const len = Math.hypot(dy, dz);
  return { y: dy / len, z: dz / len };
})();

// 이름표(.voxel-name-tag / .small)의 CSS 크기. index.css 의 값과 맞춰 둔다.
function tagCss(small: boolean, viewportW: number) {
  return small
    ? { font: Math.min(20, Math.max(12, viewportW * 0.0115)), padX: 7, padY: 2, border: 2, maxEm: 7.5 }
    : { font: Math.min(32, Math.max(20, viewportW * 0.021)), padX: 12, padY: 4, border: 3, maxEm: Infinity };
}

function textEm(nickname: string): number {
  let em = 0;
  for (const ch of nickname) em += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.62;
  return em;
}

export interface TagItem {
  id: string;
  x: number;
  z: number;
  nickname: string;
  shopHat: boolean;
}

export function layoutLabelTiers(items: TagItem[], small: boolean, canvasH: number, viewportW: number): Map<string, number> {
  const tiers = new Map<string, number>();
  if (canvasH <= 0) return tiers;
  const css = tagCss(small, viewportW);
  const focal = canvasH / 2 / FOV_TAN; // px
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  // 앞줄(카메라 쪽, z 가 큰 쪽)부터 낮은 단을 준다. 같은 줄은 왼쪽부터.
  const order = [...items].sort((a, b) => b.z - a.z || a.x - b.x || a.id.localeCompare(b.id));
  for (const it of order) {
    const wCss = Math.min(css.maxEm * css.font, textEm(it.nickname) * css.font + 2 * css.padX + 2 * css.border);
    const hCss = css.font * 1.45 + 2 * css.padY + 2 * css.border;
    let tier = 0;
    let box = { x0: 0, x1: 0, y0: 0, y1: 0 };
    for (; tier < LABEL_TIERS; tier++) {
      const px = it.x - CAMERA.x;
      const py = CHARACTER_SCALE * nameTagHeight(it.shopHat, tier * LABEL_TIER) - CAMERA.y;
      const pz = it.z - CAMERA.z;
      const depth = py * FWD.y + pz * FWD.z;
      const sx = (focal * px) / depth;
      const sy = (focal * (py * -FWD.z + pz * FWD.y)) / depth; // 화면 위쪽이 +
      // drei <Html distanceFactor>: 글자 크기는 거리에 반비례하고 캔버스 크기와는 무관하다.
      const scale = NAME_TAG_DISTANCE_FACTOR / (2 * FOV_TAN * Math.hypot(px, py, pz));
      const w = (wCss * scale) / 2 + LABEL_MARGIN_PX;
      const h = (hCss * scale) / 2 + LABEL_MARGIN_PX;
      box = { x0: sx - w, x1: sx + w, y0: sy - h, y1: sy + h };
      const b = box;
      if (!placed.some((p) => p.x0 < b.x1 && b.x0 < p.x1 && p.y0 < b.y1 && b.y0 < p.y1)) break;
    }
    placed.push(box);
    tiers.set(it.id, Math.min(tier, LABEL_TIERS - 1));
  }
  return tiers;
}

function CameraRig() {
  const { camera } = useThree();
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    camera.position.x = Math.sin(t * 0.15) * 0.5;
    camera.position.y = CAMERA.y + Math.sin(t * 0.1) * 0.25;
    camera.position.z = CAMERA.z;
    camera.lookAt(LOOK_AT.x, LOOK_AT.y, LOOK_AT.z);
  });
  return null;
}

// 정답 공개 순간 머리 위로 떠오르는 점수 표시: 정답 = 초록 +N, 오답 = 빨강 빼기(−) 막대.
// 넘어지는 캐릭터를 따라 눕지 않도록 캐릭터 안이 아니라 무대 좌표에 따로 띄운다.
const POPUP_Z_RANGE: [number, number] = [16777290, 16777280]; // 이름표(기본 범위)보다 항상 위
const POPUP_LIFT = 0.95; // 겹치는 이웃보다 한 단 위
const POPUP_NEAR_XZ = 1.35; // 이 거리 안이면 같은 무더기로 보고 위아래로 엇갈린다

/** 가까이 모인 점수 표시를 위아래로 엇갈리게 둔다 (앞줄·왼쪽부터 낮은 단). */
export function layoutPopupLifts(items: { id: string; x: number; z: number }[]): Map<string, number> {
  const lifts = new Map<string, number>();
  const order = [...items].sort((a, b) => b.z - a.z || a.x - b.x || a.id.localeCompare(b.id));
  const placed: { id: string; x: number; z: number; lift: number }[] = [];
  for (const it of order) {
    let lift = 0;
    for (;;) {
      const clash = placed.some((p) => p.lift === lift && Math.hypot(p.x - it.x, p.z - it.z) < POPUP_NEAR_XZ);
      if (!clash) break;
      lift += 1;
      if (lift >= 8) break;
    }
    lifts.set(it.id, lift);
    placed.push({ id: it.id, x: it.x, z: it.z, lift });
  }
  return lifts;
}

function ScorePopup({ position, correct, points, delayMs }: { position: [number, number, number]; correct: boolean; points: number; delayMs: number }) {
  return (
    <Html position={position} center distanceFactor={NAME_TAG_DISTANCE_FACTOR} occlude={false} zIndexRange={POPUP_Z_RANGE} style={{ pointerEvents: 'none' }}>
      <div
        className={`score-popup ${correct ? 'correct' : 'wrong'}`}
        style={{ animationDelay: `${delayMs}ms` }}
        role="img"
        aria-label={correct ? `정답 +${points}` : '오답'}
      >
        {correct ? `+${points}` : <span className="score-popup-minus" />}
      </div>
    </Html>
  );
}

/** 이번 문제에서 정답자가 얻는 점수 (지금 규칙은 문제당 1점). */
const POINTS_PER_CORRECT = 1;

interface Props {
  players: PlayerSnapshot[];
  status: RoomStatus;
  correctAnswer: 'O' | 'X' | null;
  correctPlayerIds?: string[];
  positions: Record<string, PlayerPosition>;
  zones?: Zones;
}

export function HostScene3D({ players, status, correctAnswer, correctPlayerIds, positions, zones = DEFAULT_ZONES }: Props) {
  const revealing = status === 'reveal' && correctAnswer != null;
  const canvasHeight = useThree((state) => state.size.height);
  const lobby = status === 'lobby';

  // Players spawn near the back of the map (see server randomSpawn) so the
  // fallback before the first `positions` broadcast arrives looks sane rather
  // than snapping everyone to the origin.
  // 대기실에서는 위치 방송이 없으므로 한 점에 겹치지 않게 옆으로 나란히 세운다.
  // 대기실에서는 지도 끝(z=8)이 아니라 가운데쯤에 세워서 다리가 화면 아래로 잘리지 않게 한다.
  const lineupStep = Math.min(1.6, 14 / Math.max(1, players.length));
  const spots = players.map((p, index) => {
    const pos = positions[p.id];
    return {
      x: pos?.x ?? (index - (players.length - 1) / 2) * lineupStep,
      y: pos?.y ?? 0,
      z: pos?.z ?? (lobby ? 4.6 : 8),
    };
  });
  const smallLabels = players.length > 5; // 여럿이면 작은 이름표 (대기실과 같은 기준)
  // 게임 중에는 서 있는 자리를 보고 이름표 단을 정한다 (겹치는 이웃이 있으면 위로).
  const tiers = lobby
    ? new Map<string, number>()
    : layoutLabelTiers(
        players.map((p, index) => ({ id: p.id, x: spots[index].x, z: spots[index].z, nickname: p.nickname, shopHat: !!p.cosmetics?.hat })),
        smallLabels,
        canvasHeight,
        typeof window === 'undefined' ? 1280 : window.innerWidth,
      );

  return (
    <>
      <CameraRig />
      <ambientLight intensity={0.55} />
      <directionalLight
        position={[6, 10, 6]}
        intensity={1.15}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-near={1}
        shadow-camera-far={30}
        shadow-camera-left={-12}
        shadow-camera-right={12}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
      />

      <Terrain />
      <CenterDivider />
      <Clouds />

      <LetterStructure shape="O" origin={[zoneCenterX(zones.O), 0, -1.2]} reveal={revealing ? (correctAnswer === 'O' ? 'correct' : 'wrong') : 'idle'} />
      <LetterStructure shape="X" origin={[zoneCenterX(zones.X), 0, -1.2]} reveal={revealing ? (correctAnswer === 'X' ? 'correct' : 'wrong') : 'idle'} />

      {players.map((p, index) => {
        const { x, y, z } = spots[index];
        const pos = positions[p.id];
        const isCorrect = correctPlayerIds ? correctPlayerIds.includes(p.id) : p.side === correctAnswer;
        const reveal: RevealState = revealing ? (isCorrect ? 'correct' : 'wrong') : 'idle';
        return (
          <VoxelCharacter
            key={p.id}
            gait={revealing ? undefined : pos?.gait}
            avatarId={p.avatar}
            cosmetics={p.cosmetics}
            labelSmall={smallLabels}
            labelLift={lobby ? (index % 3) * 0.55 : (tiers.get(p.id) ?? 0) * LABEL_TIER}
            nickname={p.nickname}
            target={[x, y, z]}
            moveState={pos?.state}
            reveal={reveal}
            scale={1.5}
            facing={0}
          />
        );
      })}

      {revealing &&
        (() => {
          const popupLifts = layoutPopupLifts(players.map((p, index) => ({ id: p.id, x: spots[index].x, z: spots[index].z })));
          return players.map((p, index) => {
            const { x, z } = spots[index];
            const isCorrect = correctPlayerIds ? correctPlayerIds.includes(p.id) : p.side === correctAnswer;
            const nameLift = (tiers.get(p.id) ?? 0) * LABEL_TIER;
            const popLift = (popupLifts.get(p.id) ?? 0) * POPUP_LIFT;
            return (
              <ScorePopup
                key={`popup-${p.id}`}
                position={[x, CHARACTER_SCALE * (nameTagHeight(!!p.cosmetics?.hat, nameLift) + 0.75 + popLift), z]}
                correct={isCorrect}
                points={POINTS_PER_CORRECT}
                delayMs={(popupLifts.get(p.id) ?? index % 4) * 70}
              />
            );
          });
        })()}
    </>
  );
}
