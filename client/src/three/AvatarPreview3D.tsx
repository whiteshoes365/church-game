import { Canvas } from '@react-three/fiber';
import { VoxelCharacter } from './VoxelCharacter';

interface Props {
  avatarId: string;
}

export default function AvatarPreview3D({ avatarId }: Props) {
  return (
    <Canvas dpr={[1, 1.5]} camera={{ position: [0, 1.25, 3.6], fov: 32 }}>
      <color attach="background" args={['#101522']} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[2, 3, 2]} intensity={1} />
      <group position={[0, -0.75, 0]}>
        <VoxelCharacter avatarId={avatarId} target={[0, 0, 0]} scale={1.1} showLabel={false} spin />
      </group>
    </Canvas>
  );
}
