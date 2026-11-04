import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { HostScene3D } from './HostScene3D';
import type { PlayerSnapshot, RoomStatus } from '../protocol';

interface Props {
  players: PlayerSnapshot[];
  status: RoomStatus;
  correctAnswer: 'O' | 'X' | null;
}

export default function HostCanvas3D({ players, status, correctAnswer }: Props) {
  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      camera={{ position: [0, 10.5, 15], fov: 48, near: 0.1, far: 60 }}
    >
      <color attach="background" args={['#bfe3f0']} />
      <fog attach="fog" args={['#bfe3f0', 18, 34]} />
      <Suspense fallback={null}>
        <HostScene3D players={players} status={status} correctAnswer={correctAnswer} />
      </Suspense>
    </Canvas>
  );
}
