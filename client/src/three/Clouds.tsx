import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { unitBoxGeometry } from './shared';

interface Puff {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  speed: number;
}

const CLOUD_MATERIAL = new THREE.MeshStandardMaterial({
  color: '#ffffff',
  roughness: 0.9,
  transparent: true,
  opacity: 0.92,
});

const CLUSTERS = [
  { cx: -10, cz: -4, cy: 7 },
  { cx: -3, cz: -6, cy: 8 },
  { cx: 5, cz: -5, cy: 7.5 },
  { cx: 11, cz: -3, cy: 8.2 },
];

function buildPuffs(): Puff[] {
  const puffs: Puff[] = [];
  CLUSTERS.forEach(({ cx, cz, cy }, idx) => {
    const speed = 0.22 + (idx % 3) * 0.07;
    for (let i = 0; i < 3; i++) {
      puffs.push({
        x: cx + i * 1.1 - 1.1,
        y: cy + (i === 1 ? 0.3 : 0),
        z: cz,
        sx: 1.6 - i * 0.3,
        sy: 0.7,
        sz: 1.3,
        speed,
      });
    }
  });
  return puffs;
}

const WRAP = 16;

export function Clouds() {
  const puffs = useMemo(buildPuffs, []);
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const offsets = useRef<number[]>(puffs.map(() => 0));

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    puffs.forEach((p, i) => {
      offsets.current[i] += delta * p.speed;
      let x = p.x + offsets.current[i];
      x = ((x + WRAP) % (WRAP * 2)) - WRAP;
      dummy.position.set(x, p.y, p.z);
      dummy.scale.set(p.sx, p.sy, p.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={meshRef} args={[unitBoxGeometry, CLOUD_MATERIAL, puffs.length]} frustumCulled={false} />;
}
