import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { HostScene3D } from './HostScene3D';
import type { PlayerPosition, PlayerSnapshot, RoomStatus, Zones } from '../protocol';

interface Props {
  players: PlayerSnapshot[];
  status: RoomStatus;
  correctAnswer: 'O' | 'X' | null;
  correctPlayerIds?: string[];
  positions: Record<string, PlayerPosition>;
  zones?: Zones;
}

export default function HostCanvas3D({ players, status, correctAnswer, correctPlayerIds, positions, zones }: Props) {
  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      camera={{ position: [0, 12.2, 18.2], fov: 44, near: 0.1, far: 80 }}
    >
      <color attach="background" args={['#bfe3f0']} />
      <fog attach="fog" args={['#bfe3f0', 18, 34]} />
      <Suspense fallback={null}>
        <HostScene3D players={players} status={status} correctAnswer={correctAnswer} correctPlayerIds={correctPlayerIds} positions={positions} zones={zones} />
      </Suspense>
    </Canvas>
  );
}
