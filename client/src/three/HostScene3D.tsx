import { useFrame, useThree } from '@react-three/fiber';
import { Terrain } from './Terrain';
import { LetterStructure, type RevealState } from './LetterStructure';
import { Clouds } from './Clouds';
import { VoxelCharacter } from './VoxelCharacter';
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

function CameraRig() {
  const { camera } = useThree();
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    camera.position.x = Math.sin(t * 0.15) * 0.6;
    camera.position.y = 10.5 + Math.sin(t * 0.1) * 0.3;
    camera.lookAt(0, 1.8, 1);
  });
  return null;
}

interface Props {
  players: PlayerSnapshot[];
  status: RoomStatus;
  correctAnswer: 'O' | 'X' | null;
  positions: Record<string, PlayerPosition>;
  zones?: Zones;
}

export function HostScene3D({ players, status, correctAnswer, positions, zones = DEFAULT_ZONES }: Props) {
  const revealing = status === 'reveal' && correctAnswer != null;

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
      <Clouds />

      <LetterStructure shape="O" origin={[zoneCenterX(zones.O), 0, -1.2]} reveal={revealing ? (correctAnswer === 'O' ? 'correct' : 'wrong') : 'idle'} />
      <LetterStructure shape="X" origin={[zoneCenterX(zones.X), 0, -1.2]} reveal={revealing ? (correctAnswer === 'X' ? 'correct' : 'wrong') : 'idle'} />

      {players.map((p, index) => {
        const pos = positions[p.id];
        // Players spawn near the back of the map (see server randomSpawn) so
        // the fallback before the first `positions` broadcast arrives looks
        // sane rather than snapping everyone to the origin.
        // 대기실에서는 위치 방송이 없으므로 한 점에 겹치지 않게 옆으로 나란히 세운다.
        const lineupStep = Math.min(1.6, 14 / Math.max(1, players.length));
        const x = pos?.x ?? (index - (players.length - 1) / 2) * lineupStep;
        const z = pos?.z ?? 8;
        const y = pos?.y ?? 0;
        const reveal: RevealState = revealing ? (p.side === correctAnswer ? 'correct' : 'wrong') : 'idle';
        return (
          <VoxelCharacter
            key={p.id}
            avatarId={p.avatar}
            nickname={p.nickname}
            target={[x, y, z]}
            moveState={pos?.state}
            reveal={reveal}
            scale={1.5}
            facing={0}
          />
        );
      })}
    </>
  );
}
