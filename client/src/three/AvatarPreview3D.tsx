import { Canvas } from '@react-three/fiber';
import { VoxelCharacter } from './VoxelCharacter';

import type { Cosmetics } from '../protocol';

interface Props {
  avatarId: string;
  cosmetics?: Cosmetics;
}

export default function AvatarPreview3D({ avatarId, cosmetics }: Props) {
  return (
    <Canvas dpr={[1, 1.5]} camera={{ position: [0, 1.2, 4.7], fov: 32 }}>
      <color attach="background" args={['#101522']} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[2, 3, 2]} intensity={1} />
      <group position={[0, -1.1, 0]}>
        <VoxelCharacter avatarId={avatarId} cosmetics={cosmetics} target={[0, 0, 0]} scale={1.1} showLabel={false} spin />
      </group>
    </Canvas>
  );
}
